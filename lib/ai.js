// ─────────────────────────────────────────────────────────────
// ai.js — generate a themed word list with an OpenAI API key.
//
// Moderators paste their own key and ask for a topic; this asks a
// chat model for drawable words and cleans the result up. The key
// is only ever used for the one request — it is never logged and
// never appears in an error message.
// ─────────────────────────────────────────────────────────────

const DEFAULT_MODEL = 'gpt-4o-mini';
const TIMEOUT_MS = 60 * 1000;

function friendlyError(status) {
  if (status === 401 || status === 403) return 'That API key was rejected.';
  if (status === 429) return 'OpenAI is rate-limiting that key — try again shortly.';
  if (status >= 500) return 'OpenAI had a problem — try again.';
  return 'OpenAI returned an unexpected response (' + status + ').';
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

async function generateWordList({ apiKey, topic, targetChars = 2000, model, baseUrl, signal } = {}) {
  if (!apiKey || typeof apiKey !== 'string') throw new Error('No API key was provided.');
  const cleanTopic = String(topic || '').replace(/\s+/g, ' ').trim().slice(0, 120);
  if (!cleanTopic) throw new Error('Give the generator a topic first.');

  // Words average ~9 characters with the newline; ask for a margin over the
  // target so trimming has something to trim.
  const wanted = Math.min(400, Math.ceil((targetChars / 8) * 1.3));

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  if (signal) {
    if (signal.aborted) { clearTimeout(timer); throw new Error('Cancelled.'); }
    signal.addEventListener('abort', () => controller.abort(), { once: true });
  }

  let res;
  try {
    res = await fetch((baseUrl || 'https://api.openai.com/v1') + '/chat/completions', {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + apiKey,
      },
      body: JSON.stringify({
        model: model || DEFAULT_MODEL,
        temperature: 0.9,
        response_format: { type: 'json_object' },
        messages: [
          {
            role: 'system',
            content: 'You generate word lists for a Pictionary-style drawing game. ' +
              'Every entry must be concrete and DRAWABLE (things, animals, places, simple actions), ' +
              'family-friendly, widely recognisable, lowercase, 1-3 words, no duplicates. ' +
              'Reply with JSON only: {"words": ["...", "..."]}',
          },
          {
            role: 'user',
            content: `Topic: ${cleanTopic}. Give me ${wanted} drawable words on this topic.`,
          },
        ],
      }),
    });
  } catch (e) {
    clearTimeout(timer);
    if (controller.signal.aborted) throw new Error(signal && signal.aborted ? 'Cancelled.' : 'OpenAI took too long — try again.');
    throw new Error('Could not reach OpenAI.');
  }
  clearTimeout(timer);

  if (!res.ok) throw new Error(friendlyError(res.status));

  let body;
  try { body = await res.json(); } catch (e) { throw new Error('The model did not return any usable words.'); }
  const content = body && body.choices && body.choices[0] && body.choices[0].message
    ? body.choices[0].message.content : '';

  const words = parseWords(content);
  if (!words.length) throw new Error('The model did not return any usable words.');

  const trimmed = trimToChars(words, Math.max(200, targetChars));
  return { words: trimmed.words, chars: trimmed.chars, model: model || DEFAULT_MODEL };
}

module.exports = { generateWordList, parseWords, trimToChars };
