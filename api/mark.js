// ══════════════════════════════════════════════════════════
//  Educorps — Marking serverless function  (Vercel /api/mark)
//
//  Two actions, both server-side so the student's Groq key
//  never appears in the browser network tab to other origins.
//
//  POST /api/mark
//  body: {
//    action: 'read' | 'mark',
//    groqKey: 'gsk_...',
//    ...payload
//  }
// ══════════════════════════════════════════════════════════

const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';

// Vision model for reading handwriting, text model for marking
const VISION_MODEL = 'meta-llama/llama-4-scout-17b-16e-instruct';
const TEXT_MODEL   = 'llama-3.3-70b-versatile';

export default async function handler(req, res){
  // CORS (same-origin in production, but allow preflight)
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if(req.method === 'OPTIONS'){ return res.status(200).end(); }
  if(req.method !== 'POST'){ return res.status(405).json({ error:'Method not allowed' }); }

  let body = req.body;
  if(typeof body === 'string'){ try { body = JSON.parse(body); } catch { body = {}; } }

  const { action, groqKey } = body || {};
  if(!groqKey || !groqKey.startsWith('gsk_')){
    return res.status(400).json({ error:'Missing or invalid Groq key' });
  }

  try {
    if(action === 'read'){
      return await handleRead(body, groqKey, res);
    } else if(action === 'mark'){
      return await handleMark(body, groqKey, res);
    } else {
      return res.status(400).json({ error:'Unknown action' });
    }
  } catch(e){
    return res.status(500).json({ error: e.message || 'Server error' });
  }
}

// ── ACTION: read handwriting from an image ──
async function handleRead(body, groqKey, res){
  const { imageBase64 } = body;
  if(!imageBase64){ return res.status(400).json({ error:'No image provided' }); }

  const dataUrl = imageBase64.startsWith('data:')
    ? imageBase64
    : `data:image/jpeg;base64,${imageBase64}`;

  const r = await fetch(GROQ_URL, {
    method:'POST',
    headers:{ 'Authorization':`Bearer ${groqKey}`, 'Content-Type':'application/json' },
    body: JSON.stringify({
      model: VISION_MODEL,
      temperature: 0,
      max_tokens: 1024,
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
    const errText = await r.text();
    return res.status(r.status).json({ error:`Groq vision error: ${errText.slice(0,200)}` });
  }
  const data = await r.json();
  const text = data.choices?.[0]?.message?.content || '';
  return res.status(200).json({ text: text.trim() });
}

// ── ACTION: mark a descriptive answer against mark points ──
async function handleMark(body, groqKey, res){
  const { studentText, question, markPoints, maxMarks, subject, command } = body;

  const prompt = buildMarkingPrompt({
    studentText, question, markPoints, maxMarks, subject, command,
  });

  const r = await fetch(GROQ_URL, {
    method:'POST',
    headers:{ 'Authorization':`Bearer ${groqKey}`, 'Content-Type':'application/json' },
    body: JSON.stringify({
      model: TEXT_MODEL,
      temperature: 0.1,
      max_tokens: 700,
      messages: [{ role:'user', content: prompt }],
    }),
  });

  if(!r.ok){
    const errText = await r.text();
    return res.status(r.status).json({ error:`Groq marking error: ${errText.slice(0,200)}` });
  }

  const data = await r.json();
  const raw = data.choices?.[0]?.message?.content || '';

  // Parse the JSON the model returns
  const match = raw.match(/\{[\s\S]*\}/);
  if(!match){
    return res.status(200).json({
      awarded: 0, maxMarks: maxMarks || 0,
      feedback: 'Could not parse marking result.', raw: raw.slice(0,200),
    });
  }
  let result;
  try { result = JSON.parse(match[0]); }
  catch { return res.status(200).json({ awarded:0, maxMarks:maxMarks||0, feedback:'Marking parse error.' }); }

  // Clamp awarded marks to valid range
  let awarded = Number(result.awarded) || 0;
  awarded = Math.max(0, Math.min(awarded, maxMarks || 0));

  return res.status(200).json({
    awarded,
    maxMarks: maxMarks || 0,
    feedback: result.feedback || '',
    pointsHit: result.points_hit || [],
    pointsMissed: result.points_missed || [],
  });
}

function buildMarkingPrompt({ studentText, question, markPoints, maxMarks, subject, command }){
  const points = Array.isArray(markPoints) ? markPoints : [];
  const pointsList = points.map((p,i) => `${i+1}. ${p}`).join('\n');

  return `You are an experienced Cambridge IGCSE ${subject || ''} examiner marking a student's answer.

QUESTION (${command || 'answer'}): ${question || '(question text unavailable)'}

MARK SCHEME — award one mark for each point the student makes (max ${maxMarks} marks):
${pointsList || '(no specific points provided — use your judgement)'}

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
