/**
 * Flash Cards — Persian TTS Proxy (Cloudflare Worker)
 * ====================================================
 * Proxies Google Translate TTS with better caching + CORS headers,
 * and adds Microsoft Edge TTS support for superior Persian voice quality.
 *
 * DEPLOY STEPS (one-time, ~5 min):
 *   1. Go to: dash.cloudflare.com → Workers & Pages → Create
 *   2. Click "Create Worker"
 *   3. Name it: flash-tts
 *   4. Click "Deploy", then "Edit code"
 *   5. Paste this entire file, click "Deploy"
 *   6. Copy your worker URL (e.g. https://flash-tts.YOUR-SUBDOMAIN.workers.dev)
 *   7. Give URL to Behnam to put in the app
 *
 * Endpoint:
 *   GET /tts?text=سلام&lang=fa
 *
 * Supported lang values:
 *   fa  → Persian  (fa-IR-DilaraNeural — Microsoft Edge TTS)
 *   ar  → Arabic   (ar-SA-ZariyahNeural)
 *   en  → English  (en-US-JennyNeural)
 *
 * Free quota: 100,000 req/day on Cloudflare Workers free plan.
 */

// ── Config ─────────────────────────────────────────────────────────────────
const EDGE_TOKEN_URL =
  'https://www.bing.com/tfetspeak?isTTSFull=true&isspeech=true';

const VOICES = {
  fa: 'fa-IR-DilaraNeural',
  ar: 'ar-SA-ZariyahNeural',
  en: 'en-US-JennyNeural',
};

// Cloudflare KV cache (optional — only if you bind a KV namespace called TTS_CACHE)
// Without it, we still work fine, just no edge caching between requests.

// ── Main ───────────────────────────────────────────────────────────────────
export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Health check
    if (url.pathname === '/') {
      return ok('Flash TTS Worker is running ✓');
    }

    if (url.pathname !== '/tts') {
      return new Response('Not found', { status: 404 });
    }

    // CORS preflight
    if (request.method === 'OPTIONS') {
      return cors(null, 204);
    }

    const text = (url.searchParams.get('text') || '').trim();
    const lang = (url.searchParams.get('lang') || 'fa').toLowerCase().slice(0, 2);

    if (!text) return cors('Missing ?text=', 400);
    if (text.length > 300) return cors('Text too long (max 300 chars)', 400);
    if (!VOICES[lang])     return cors(`Unknown lang "${lang}" — use fa, ar, en`, 400);

    const voice = VOICES[lang];

    // Try Edge TTS (best quality)
    try {
      const mp3 = await edgeTTS(text, voice, lang);
      return new Response(mp3, {
        status: 200,
        headers: {
          'Content-Type': 'audio/mpeg',
          'Cache-Control': 'public, max-age=604800', // 7 days
          'Access-Control-Allow-Origin': '*',
        },
      });
    } catch (e1) {
      // Fallback: proxy Google Translate TTS
      try {
        const mp3 = await googleTTS(text, lang);
        return new Response(mp3, {
          status: 200,
          headers: {
            'Content-Type': 'audio/mpeg',
            'Cache-Control': 'public, max-age=86400',
            'Access-Control-Allow-Origin': '*',
          },
        });
      } catch (e2) {
        return cors(`TTS failed: ${e1.message} / ${e2.message}`, 502);
      }
    }
  },
};

// ── Edge TTS ───────────────────────────────────────────────────────────────
async function edgeTTS(text, voice, lang) {
  // Get auth token from Bing
  const tokenResp = await fetch(
    'https://www.bing.com/tfetspeak?isTTSFull=true&isspeech=true',
    {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
        Referer: 'https://www.bing.com/',
      },
    }
  );

  if (!tokenResp.ok) throw new Error(`Token fetch failed: ${tokenResp.status}`);
  const token = tokenResp.headers.get('X-TTSToken') || await tokenResp.text();

  const ssml = `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='${lang === 'fa' ? 'fa-IR' : lang === 'ar' ? 'ar-SA' : 'en-US'}'>
  <voice name='${voice}'>
    <prosody rate='-8%' pitch='0%'>${escapeXML(text)}</prosody>
  </voice>
</speak>`;

  const ttsResp = await fetch(
    'https://www.bing.com/tfetspeak',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/ssml+xml',
        'X-TTSToken': token.trim(),
        'X-Microsoft-OutputFormat': 'audio-24khz-48kbitrate-mono-mp3',
        'User-Agent':
          'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15',
        Referer: 'https://www.bing.com/',
        Origin: 'https://www.bing.com',
      },
      body: ssml,
    }
  );

  if (!ttsResp.ok) throw new Error(`Edge TTS synthesis failed: ${ttsResp.status}`);
  return ttsResp.arrayBuffer();
}

// ── Google Translate TTS (fallback) ────────────────────────────────────────
async function googleTTS(text, lang) {
  const tl = lang === 'fa' ? 'fa' : lang === 'ar' ? 'ar' : 'en';
  const u = `https://translate.googleapis.com/translate_tts?ie=UTF-8&tl=${tl}&client=gtx&q=${encodeURIComponent(text)}`;
  const r = await fetch(u, {
    headers: { 'User-Agent': 'Mozilla/5.0' },
  });
  if (!r.ok) throw new Error(`Google TTS failed: ${r.status}`);
  return r.arrayBuffer();
}

// ── Helpers ────────────────────────────────────────────────────────────────
function escapeXML(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function cors(body, status = 200) {
  return new Response(body, {
    status,
    headers: {
      'Content-Type': 'text/plain',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
  });
}

function ok(msg) {
  return new Response(msg, {
    status: 200,
    headers: { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*' },
  });
}
