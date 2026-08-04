// ══════════════════════════════════════════════════════════
//  Educorps — Marking serverless function  (Vercel /api/mark)
//
//  The mark scheme NEVER reaches the browser. This function
//  fetches it with the service-role key, pairs it with the
//  paper's questions, routes each answer, and returns only
//  scores + feedback.
//
//  Required Vercel environment variable:
//    SUPABASE_SERVICE_KEY  — your Supabase service_role key
//
//  POST /api/mark
//    { action: 'read',      groqKey, imageBase64 }
//    { action: 'markPaper', groqKey, paper, questions, answers }
// ══════════════════════════════════════════════════════════

const GROQ_URL     = 'https://api.groq.com/openai/v1/chat/completions';
// Groq retires models often — if you see "model_not_found", check
// https://console.groq.com/docs/deprecations and update these two lines.
// Last verified: August 2026
const VISION_MODEL = 'qwen/qwen3.6-27b';      // multimodal (reads handwriting)
const TEXT_MODEL   = 'openai/gpt-oss-120b';   // text-only (descriptive marking)

const SUPABASE_URL = 'https://yirvkjjrfvqeyjrzgahm.supabase.co';

// ══════════════════════════════════════════════════════════
//  HANDLER
// ══════════════════════════════════════════════════════════
export default async function handler(req, res){
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if(req.method === 'OPTIONS') return res.status(200).end();
  if(req.method !== 'POST')    return res.status(405).json({ error:'Method not allowed' });

  let body = req.body;
  if(typeof body === 'string'){ try { body = JSON.parse(body); } catch { body = {}; } }

  const { action, groqKey } = body || {};
  if(!groqKey || !String(groqKey).startsWith('gsk_')){
    return res.status(400).json({ error:'Missing or invalid Groq key' });
  }

  try {
    if(action === 'read')      return await handleRead(body, groqKey, res);
    if(action === 'markPaper') return await handleMarkPaper(body, groqKey, res);
    return res.status(400).json({ error:'Unknown action' });
  } catch(e){
    return res.status(500).json({ error: e.message || 'Server error' });
  }
}

// ══════════════════════════════════════════════════════════
//  ACTION: read handwriting from an image
//  (Swap this for your own OCR later — keep the same output.)
// ══════════════════════════════════════════════════════════
async function handleRead(body, groqKey, res){
  const { imageBase64 } = body;
  if(!imageBase64) return res.status(400).json({ error:'No image provided' });

  const dataUrl = String(imageBase64).startsWith('data:')
    ? imageBase64
    : `data:image/jpeg;base64,${imageBase64}`;

  const r = await fetch(GROQ_URL, {
    method:'POST',
    headers:{ 'Authorization':`Bearer ${groqKey}`, 'Content-Type':'application/json' },
    body: JSON.stringify({
      model: VISION_MODEL, temperature: 0, max_tokens: 1024,
      messages: [{
        role:'user',
        content:[
          { type:'text', text:'Transcribe the handwritten answer in this image to plain text exactly as written, including any numbers, units, and working. Output ONLY the transcription, no commentary.' },
          { type:'image_url', image_url:{ url: dataUrl } },
        ],
      }],
    }),
  });

  if(!r.ok){
    const t = await r.text();
    return res.status(r.status).json({ error:`Groq vision error: ${t.slice(0,200)}` });
  }
  const data = await r.json();
  return res.status(200).json({ text: (data.choices?.[0]?.message?.content || '').trim() });
}

// ══════════════════════════════════════════════════════════
//  ACTION: mark a whole paper
// ══════════════════════════════════════════════════════════
async function handleMarkPaper(body, groqKey, res){
  const { paper, questions, answers } = body;
  if(!paper || !Array.isArray(questions) || !Array.isArray(answers)){
    return res.status(400).json({ error:'Missing paper, questions or answers' });
  }

  const serviceKey = process.env.SUPABASE_SERVICE_KEY;
  if(!serviceKey){
    return res.status(500).json({ error:'Server not configured: SUPABASE_SERVICE_KEY missing' });
  }

  // ── Fetch the mark scheme server-side (service role bypasses RLS) ──
  let msArray = [];
  try {
    const url = `${SUPABASE_URL}/rest/v1/content`
      + `?type=eq.markscheme`
      + `&subject=eq.${encodeURIComponent(paper.subject || '')}`
      + `&paper_code=eq.${encodeURIComponent(paper.paper_code || '')}`
      + `&session=eq.${encodeURIComponent(paper.session || '')}`
      + `&select=questions`;
    const r = await fetch(url, {
      headers:{ apikey: serviceKey, Authorization:`Bearer ${serviceKey}` },
    });
    if(r.ok){
      const rows = await r.json();
      const withQ = (rows || []).find(x => Array.isArray(x.questions) && x.questions.length > 0);
      if(withQ) msArray = withQ.questions;
    }
  } catch(e){ /* fall through — engine handles an empty mark scheme */ }

  // ── Pair + route ──
  const plan = planMarking(questions, msArray);

  // ── Mark each submitted answer ──
  const results = [];
  for(const a of answers){
    const idx    = a.qIndex;
    const paired = plan[idx];
    if(!paired) continue;

    const text = stripQuestionLabels(a.studentText || '');
    if(!text){
      results.push({ qIndex:idx, q:paired.q, awarded:0, maxMarks:paired.marks||0,
        feedback:'No answer detected in the image.', route:'none' });
      continue;
    }

    const routing = paired.routing;
    if(routing.route === 'numerical'){
      const out = markNumerical(text, paired.ms || {}, routing.maxMarks);
      results.push({ qIndex:idx, q:paired.q, ...out, route:'numerical' });
    } else {
      try {
        const out = await markDescriptive(text, paired, groqKey, paper.subject);
        results.push({ qIndex:idx, q:paired.q, ...out, route:'descriptive' });
      } catch(e){
        results.push({ qIndex:idx, q:paired.q, awarded:0, maxMarks:paired.marks||0,
          feedback:'Could not mark: '+e.message, route:'error' });
      }
    }
  }

  // Return only what the student is allowed to see — no mark scheme
  return res.status(200).json({
    results,
    markSchemeFound: msArray.length > 0,
    perQuestionMarks: plan.map(p => ({ q:p.q, marks:p.marks })),
  });
}

// ══════════════════════════════════════════════════════════
//  FOUNDATION — question ID normalisation + pairing
// ══════════════════════════════════════════════════════════
function normalizeQID(raw){
  if(raw === null || raw === undefined) return '';
  let s = String(raw).toLowerCase().trim();
  const roman = { i:'1', ii:'2', iii:'3', iv:'4', v:'5', vi:'6', vii:'7', viii:'8', ix:'9', x:'10' };
  s = s.replace(/[()\[\].]/g, ' ').replace(/\s+/g, ' ').trim();
  s = s.replace(/(\d)([a-z])/g, '$1 $2').replace(/([a-z])(\d)/g, '$1 $2');
  return s.split(' ').filter(Boolean).map(p => roman[p] !== undefined ? roman[p] : p).join('-');
}

function buildMSLookup(msArray){
  const map = {};
  if(!Array.isArray(msArray)) return map;
  msArray.forEach(e => { const k = normalizeQID(e.q); if(k) map[k] = e; });
  return map;
}

const NUMERICAL_COMMANDS   = ['calculate','find','solve','show','determine','convert','complete','state','write','give','measure','count','work out'];
const DESCRIPTIVE_COMMANDS = ['explain','describe','evaluate','suggest','compare','analyse','analyze','define','discuss','justify','assess','outline','identify'];
function inferTypeFromCommand(command){
  const c = (command || '').toLowerCase().trim();
  if(NUMERICAL_COMMANDS.some(w => c.includes(w)))   return 'numerical';
  if(DESCRIPTIVE_COMMANDS.some(w => c.includes(w))) return 'descriptive';
  return 'descriptive';
}

function pairQuestionsWithMS(questions, msArray){
  const lookup = buildMSLookup(msArray);
  return (questions || []).map(q => {
    const key = normalizeQID(q.q);
    const ms  = lookup[key] || null;
    let marks = Number(q.marks) || 0;
    if((!marks || marks === 0) && ms && ms.max_marks) marks = Number(ms.max_marks) || 0;
    let type = q.type;
    if(type !== 'numerical' && type !== 'descriptive') type = inferTypeFromCommand(q.command);
    return { q:q.q, qid:key, text:q.text || '', marks, command:(q.command || '').toLowerCase(), type, ms };
  });
}

// ══════════════════════════════════════════════════════════
//  SCANNER 0 — router
// ══════════════════════════════════════════════════════════
function scanner0(q){
  const ms = q.ms;
  const maxMarks = q.marks || (ms && ms.max_marks) || 1;
  if(!ms) return { route:'descriptive', reason:'no-markscheme', maxMarks, ms:null };

  const hasFixedAnswer = ms.answer !== null && ms.answer !== undefined && String(ms.answer).trim() !== '';
  if(hasFixedAnswer) return { route:'numerical', reason:'fixed-answer', maxMarks, ms };

  const hasMarkPoints = Array.isArray(ms.mark_points) && ms.mark_points.length > 0;
  if(hasMarkPoints) return { route:'descriptive', reason:'mark-points', maxMarks, ms };

  if(q.type === 'numerical') return { route:'numerical', reason:'question-type', maxMarks, ms };
  return { route:'descriptive', reason:'default', maxMarks, ms };
}

function planMarking(questions, msArray){
  return pairQuestionsWithMS(questions, msArray).map(q => ({ ...q, routing: scanner0(q) }));
}

// ══════════════════════════════════════════════════════════
//  SCANNERS 1 + 2 — numerical and working (no API cost)
// ══════════════════════════════════════════════════════════
function extractNumbers(text){
  if(!text) return [];
  const cleaned = String(text).replace(/,/g, '');
  return (cleaned.match(/-?\d+\.?\d*(?:[eE][-+]?\d+)?/g) || []).map(Number).filter(n => !isNaN(n));
}

function numbersMatch(student, correct){
  if(correct === 0) return Math.abs(student) < 1e-6;
  return Math.abs((student - correct) / correct) < 0.015;
}

function scanner1Numerical(studentText, ms, maxMarks){
  const acceptable = [];
  if(ms.answer !== null && ms.answer !== undefined) extractNumbers(ms.answer).forEach(n => acceptable.push(n));
  if(Array.isArray(ms.alternatives)) ms.alternatives.forEach(alt => extractNumbers(alt).forEach(n => acceptable.push(n)));

  // Mark scheme answer is TEXT → string match
  if(acceptable.length === 0){
    const s = String(studentText).toLowerCase().trim();
    const a = String(ms.answer || '').toLowerCase().trim();
    if(a === '') return { correct:false, awarded:0, note:'no mark scheme answer' };
    if(s.includes(a) || (a.length > 3 && a.includes(s) && s.length > 2)){
      return { correct:true, awarded:maxMarks, note:'text answer matched' };
    }
    const words = a.split(/\s+/).filter(w => w.length > 2);
    if(words.length > 0 && words.every(w => s.includes(w))){
      return { correct:true, awarded:maxMarks, note:'text keywords matched' };
    }
    return { correct:false, awarded:0, note:'text answer did not match' };
  }

  // Numeric match
  const nums = extractNumbers(studentText);
  if(nums.length === 0) return { correct:false, awarded:0, note:'no number found in answer' };
  const final = nums[nums.length - 1];
  const hit = acceptable.some(a => numbersMatch(final, a))
           || acceptable.some(a => nums.some(n => numbersMatch(n, a)));
  return hit
    ? { correct:true, awarded:maxMarks, matchedValue:final, note:'correct answer' }
    : { correct:false, awarded:0, studentFinal:final, note:'answer incorrect' };
}

function scanner2Working(studentText, ms, maxMarks){
  const methodMarks = Array.isArray(ms.method_marks) ? ms.method_marks : [];
  if(methodMarks.length === 0) return { awarded:0, matched:[], note:'no method marks available' };

  const lower = String(studentText).toLowerCase();
  const nums  = extractNumbers(studentText);
  const matched = [];

  methodMarks.forEach(mp => {
    const mpStr  = String(mp).toLowerCase();
    const mpNums = extractNumbers(mp);
    const numHit = mpNums.length > 0 && mpNums.some(mn => nums.some(sn => numbersMatch(sn, mn)));
    const key    = mpStr.replace(/[^a-z0-9=]/g,'');
    const phraseHit = key.length > 2 && lower.replace(/\s+/g,'').includes(key.slice(0,6));
    if(numHit || phraseHit) matched.push(mp);
  });

  const cap = Math.max(0, maxMarks - 1); // can't get full marks with a wrong final answer
  return { awarded: Math.min(matched.length, cap), matched, note:'ok' };
}

function markNumerical(studentText, ms, maxMarks){
  const s1 = scanner1Numerical(studentText, ms, maxMarks);
  if(s1.correct){
    return { awarded:s1.awarded, maxMarks, correct:true, feedback:'Correct answer.', detail:s1.note };
  }
  const s2 = scanner2Working(studentText, ms, maxMarks);
  return {
    awarded: s2.awarded, maxMarks, correct:false,
    feedback: s2.awarded > 0
      ? `Final answer incorrect, but ${s2.awarded} method mark(s) awarded for correct working.`
      : 'Answer incorrect.',
    detail: s2.note, matchedMethod: s2.matched,
  };
}

// ══════════════════════════════════════════════════════════
//  SCANNER 3 — descriptive marking via Groq
// ══════════════════════════════════════════════════════════
async function markDescriptive(studentText, paired, groqKey, subject){
  const ms       = paired.ms || {};
  const maxMarks = paired.marks || ms.max_marks || 1;
  const prompt   = buildMarkingPrompt({
    studentText, question: paired.text,
    markPoints: ms.mark_points || [], maxMarks,
    subject: subject || '', command: paired.command || '',
  });

  const r = await fetch(GROQ_URL, {
    method:'POST',
    headers:{ 'Authorization':`Bearer ${groqKey}`, 'Content-Type':'application/json' },
    body: JSON.stringify({
      model: TEXT_MODEL, temperature: 0.1, max_tokens: 700,
      messages: [{ role:'user', content: prompt }],
    }),
  });

  if(!r.ok){
    const t = await r.text();
    throw new Error(`Groq marking error: ${t.slice(0,160)}`);
  }

  const data = await r.json();
  const raw  = data.choices?.[0]?.message?.content || '';
  const m    = raw.match(/\{[\s\S]*\}/);
  if(!m) return { awarded:0, maxMarks, feedback:'Could not parse marking result.' };

  let parsed;
  try { parsed = JSON.parse(m[0]); }
  catch { return { awarded:0, maxMarks, feedback:'Marking parse error.' }; }

  let awarded = Number(parsed.awarded) || 0;
  awarded = Math.max(0, Math.min(awarded, maxMarks));

  return {
    awarded, maxMarks,
    correct: awarded >= maxMarks,
    feedback: parsed.feedback || '',
    pointsHit:    parsed.points_hit    || [],
    pointsMissed: parsed.points_missed || [],
  };
}

function buildMarkingPrompt({ studentText, question, markPoints, maxMarks, subject, command }){
  const pts = (Array.isArray(markPoints) ? markPoints : []).map((p,i) => `${i+1}. ${p}`).join('\n');
  return `You are an experienced Cambridge IGCSE ${subject || ''} examiner marking a student's answer.

QUESTION (${command || 'answer'}): ${question || '(question text unavailable)'}

MARK SCHEME — award one mark for each point the student makes (max ${maxMarks} marks):
${pts || '(no specific points provided — use your judgement)'}

STUDENT'S ANSWER:
"${studentText || '(blank)'}"

Mark strictly to the Cambridge mark scheme. A point counts only if the student clearly expresses that idea (synonyms and equivalent phrasing are fine, but vague or incorrect statements do not earn the mark). Do not award marks for points not in the scheme.

Respond with ONLY a JSON object, no other text:
{
  "awarded": <integer 0 to ${maxMarks}>,
  "points_hit": ["the mark scheme points the student earned"],
  "points_missed": ["the mark scheme points the student missed"],
  "feedback": "<one or two short sentences of constructive feedback for the student>"
}`;
}

// ══════════════════════════════════════════════════════════
//  Strip leading question labels ("1) a)", "ii)", "iv)")
//  Must not eat decimals like 2.4
// ══════════════════════════════════════════════════════════
function stripQuestionLabels(text){
  if(!text) return '';
  let t = String(text).trim();
  for(let i=0; i<4; i++){
    const before = t;
    t = t.replace(/^\s*\(?\s*(\d{1,2}|[a-z]|i{1,3}|iv|v|vi{0,3}|ix|x)\s*\.?\s*\)\s*/i, '');
    if(t === before) break;
  }
  return t.trim();
}
