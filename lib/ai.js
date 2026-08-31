// ─────────────────────────────────────────────────────────────
// ai.js — generate a themed word list with a Google Gemini API key.
//
// Moderators paste their own key and ask for a topic; this asks Gemini for
// drawable words and cleans the result up. The key is only ever used for
// the one request — it is never logged and never appears in an error
// message.
//
// Keys come from https://aistudio.google.com/apikey — free tier included,
// which is why this moved off OpenAI.
// ─────────────────────────────────────────────────────────────

const DEFAULT_MODEL = 'gemini-2.0-flash';
const DEFAULT_BASE = 'https://generativelanguage.googleapis.com/v1beta';
const TIMEOUT_MS = 60 * 1000;

function friendlyError(status, body) {
  const err = (body && body.error) || {};
  const detail = String(err.message || '');
  const reason = String(err.status || '');

  if (/API key not valid|API_KEY_INVALID/i.test(detail) || reason === 'UNAUTHENTICATED' || status === 401) {
    return 'That API key was rejected — check you copied all of it from aistudio.google.com/apikey.';
  }
  if (/quota|billing/i.test(detail) || reason === 'RESOURCE_EXHAUSTED' || status === 429) {
    return 'That key has hit its Gemini quota — the free tier resets, so try again in a minute.';
  }
  if (reason === 'PERMISSION_DENIED' || status === 403) {
    return 'That key is not allowed to use this model. Make sure the Generative Language API is enabled for it.';
  }
  if (status === 404) {
    return 'That key cannot reach the ' + DEFAULT_MODEL + ' model.';
  }
  if (status >= 500) return 'Gemini had a problem — try again.';
  return 'Gemini returned an unexpected response (' + status + ').';
}

// Pull a word list out of whatever the model actually sent back.
function parseWords(content) {
  let text = String(content || '').trim();
  // Strip a markdown fence if the model wrapped its answer in one.
  const fence = text.match(/^```[a-z]*\s*([\s\S]*?)```/i);
  if (fence) text = fence[1].trim();

  // Preferred shape: {"words": [...]}. Fall back to any JSON array, then to
  // a plain newline/comma list.
  let words = null;
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) words = parsed;
    else if (parsed && Array.isArray(parsed.words)) words = parsed.words;
  } catch (e) { /* not JSON — fine */ }
  if (!words) {
    words = text.split(/[\n,]+/);
  }

  const seen = new Set();
  const out = [];
  for (const raw of words) {
    if (typeof raw !== 'string') continue;
    const w = raw.replace(/^[\s\d.\-*•)]+/, '').replace(/\s+/g, ' ').trim().toLowerCase();
    if (!w || w.length > 64) continue;
    if (!/^[\p{L}\p{N}][\p{L}\p{N} '\-]*$/u.test(w)) continue;
    if (w.split(' ').length > 3) continue;
    if (seen.has(w)) continue;
    seen.add(w);
    out.push(w);
  }
  return out;
}

// Trim the list so the joined text lands near targetChars — whole words only.
function trimToChars(words, targetChars) {
  const kept = [];
  let chars = 0;
  for (const w of words) {
    const next = chars + w.length + (kept.length ? 1 : 0);
    if (next > targetChars && kept.length > 0) break;
    kept.push(w);
    chars = next;
  }
  return { words: kept, chars };
}

const SYSTEM = 'You generate word lists for a Pictionary-style drawing game. '
  + 'Every entry must be concrete and DRAWABLE (things, animals, places, simple actions), '
  + 'family-friendly, widely recognisable, lowercase, 1-3 words, no duplicates. '
  + 'Reply with JSON only: {"words": ["...", "..."]}';

async function generateWordList({ apiKey, topic, targetChars = 2000, model, baseUrl, signal } = {}) {
  if (!apiKey || typeof apiKey !== 'string') throw new Error('No API key was provided.');
  const cleanTopic = String(topic || '').replace(/\s+/g, ' ').trim().slice(0, 120);
  if (!cleanTopic) throw new Error('Give the generator a topic first.');

  // Words average ~9 characters with the separator; ask for a margin over the
  // target so trimming has something to trim.
  const wanted = Math.min(400, Math.ceil((targetChars / 8) * 1.3));
  const useModel = model || DEFAULT_MODEL;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  if (signal) {
    if (signal.aborted) { clearTimeout(timer); throw new Error('Cancelled.'); }
    signal.addEventListener('abort', () => controller.abort(), { once: true });
  }

  // Gemini takes the key as a header, so it never lands in a URL (and so
  // never in a proxy log).
  let res;
  try {
    res = await fetch(`${baseUrl || DEFAULT_BASE}/models/${useModel}:generateContent`, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': apiKey,
      },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: SYSTEM }] },
        contents: [{
          role: 'user',
          parts: [{ text: `Topic: ${cleanTopic}. Give me ${wanted} drawable words on this topic.` }],
        }],
        generationConfig: {
          temperature: 0.9,
          responseMimeType: 'application/json',
        },
      }),
    });
  } catch (e) {
    clearTimeout(timer);
    if (controller.signal.aborted) {
      throw new Error(signal && signal.aborted ? 'Cancelled.' : 'Gemini took too long — try again.');
    }
    throw new Error('Could not reach Gemini.');
  }
  clearTimeout(timer);

  if (!res.ok) {
    let errBody = null;
    try { errBody = await res.json(); } catch (e) { /* not JSON — the status still tells us enough */ }
    throw new Error(friendlyError(res.status, errBody));
  }

  let body;
  try { body = await res.json(); } catch (e) { throw new Error('The model did not return any usable words.'); }

  // candidates[0].content.parts[] — join every text part, since a long reply
  // can be split across several.
  const parts = body && body.candidates && body.candidates[0]
    && body.candidates[0].content && body.candidates[0].content.parts;
  const content = Array.isArray(parts) ? parts.map(p => p && p.text).filter(Boolean).join('') : '';

  const words = parseWords(content);
  if (!words.length) throw new Error('The model did not return any usable words.');

  const trimmed = trimToChars(words, Math.max(200, targetChars));
  return { words: trimmed.words, chars: trimmed.chars, model: useModel };
}

module.exports = { generateWordList, parseWords, trimToChars, DEFAULT_MODEL };
