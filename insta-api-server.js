'use strict';

/**
 * InstaSave API — insta-api-server.js
 *
 * Zero external API keys required. This server:
 *  1. Self-generates its own API_KEY on first boot (or reads from env).
 *  2. Tries 5 scraping strategies in order, stopping at the first success.
 *  3. Ready to deploy free on Render.com (render.yaml included).
 *
 * Strategies (in order):
 *   1. og:video  — works on most public posts
 *   2. ld+json   — structured data embed
 *   3. ?__a=1    — Instagram's own JSON endpoint
 *   4. _sharedData — window._sharedData inline script
 *   5. GraphQL   — /graphql/query/ public endpoint
 */

const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');

// ─── 1. API-KEY BOOTSTRAP (no external service needed) ───────────────────────

let API_KEY = process.env.API_KEY;
if (!API_KEY) {
  API_KEY = crypto.randomBytes(32).toString('hex');
  console.log('\n╔══════════════════════════════════════════════════════════╗');
  console.log('║  InstaSave API — First Boot Key Generation               ║');
  console.log('╠══════════════════════════════════════════════════════════╣');
  console.log('║                                                          ║');
  console.log(`║  API_KEY=${API_KEY.slice(0, 24)}...  ║`);
  console.log('║                                                          ║');
  console.log('║  → Copy the FULL key below and add it in Render.com     ║');
  console.log('║    Dashboard → Environment → API_KEY = <key>            ║');
  console.log('║  → Then redeploy so the key survives restarts.          ║');
  console.log('║                                                          ║');
  console.log('╚══════════════════════════════════════════════════════════╝');
  console.log(`\nFULL KEY: API_KEY=${API_KEY}\n`);
}

const PORT = process.env.PORT || 3000;

// ─── 2. EXPRESS + MIDDLEWARE ──────────────────────────────────────────────────

const app = express();
app.use(express.json());

app.use(
  rateLimit({
    windowMs: 60_000,
    max: 60,
    standardHeaders: true,
    legacyHeaders: false,
    handler: (_req, res) =>
      res.status(429).json({ error: 'Too many requests. Please wait a moment.' }),
  })
);

// ─── 3. HELPERS ───────────────────────────────────────────────────────────────

const BROWSER_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept-Language': 'en-US,en;q=0.9',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Encoding': 'gzip, deflate, br',
  'Cache-Control': 'no-cache',
  'sec-fetch-dest': 'document',
  'sec-fetch-mode': 'navigate',
  'sec-fetch-site': 'none',
};

const MOBILE_HEADERS = {
  'User-Agent':
    'Instagram 275.0.0.27.98 Android (33/13; 420dpi; 1080x2400; samsung; SM-G991B; o1s; exynos2100; en_US; 458229258)',
  'Accept-Language': 'en-US',
  Accept: '*/*',
  'X-IG-App-ID': '936619743392459',
  'X-IG-WWW-Claim': '0',
  Connection: 'keep-alive',
};

function extractShortcode(url) {
  const m = url.match(
    /(?:instagram\.com|instagr\.am)\/(?:p|reel|tv|reels)\/([A-Za-z0-9_-]+)/
  );
  return m ? m[1] : null;
}

function isValidInstagramUrl(url) {
  return /^https?:\/\/(www\.)?(instagram\.com|instagr\.am)\/(p|reel|tv|reels)\/[A-Za-z0-9_-]+/.test(
    url.trim()
  );
}

function isLoginRedirect(responseUrl = '') {
  return responseUrl.includes('/accounts/login/') || responseUrl.includes('/challenge/');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ─── 4. SCRAPING STRATEGIES ───────────────────────────────────────────────────

// Strategy A: og:video meta tag
async function tryOgMeta(shortcode) {
  const url = `https://www.instagram.com/p/${shortcode}/`;
  const res = await axios.get(url, {
    headers: BROWSER_HEADERS,
    maxRedirects: 5,
    timeout: 15_000,
  });
  if (isLoginRedirect(res.request?.res?.responseUrl)) {
    throw Object.assign(new Error('Private post'), { code: 'PRIVATE' });
  }
  const $ = cheerio.load(res.data);
  const videoUrl = $('meta[property="og:video"]').attr('content');
  if (!videoUrl) return null;
  return {
    videoUrl,
    thumbnail: $('meta[property="og:image"]').attr('content') || '',
    title: $('meta[property="og:title"]').attr('content') || '',
    description: $('meta[property="og:description"]').attr('content') || '',
    method: 'og_meta',
  };
}

// Strategy B: application/ld+json structured data
async function tryLdJson(shortcode) {
  const url = `https://www.instagram.com/p/${shortcode}/`;
  const res = await axios.get(url, {
    headers: BROWSER_HEADERS,
    maxRedirects: 5,
    timeout: 15_000,
  });
  if (isLoginRedirect(res.request?.res?.responseUrl)) {
    throw Object.assign(new Error('Private post'), { code: 'PRIVATE' });
  }
  const $ = cheerio.load(res.data);
  let result = null;
  $('script[type="application/ld+json"]').each((_i, el) => {
    if (result) return;
    try {
      const json = JSON.parse($(el).html() || '{}');
      const items = Array.isArray(json) ? json : [json];
      for (const obj of items) {
        const videoUrl =
          obj.contentUrl ||
          obj.video?.contentUrl ||
          (Array.isArray(obj.video) ? obj.video[0]?.contentUrl : null);
        if (videoUrl) {
          result = {
            videoUrl,
            thumbnail: obj.thumbnailUrl || obj.image || '',
            title: obj.name || obj.headline || '',
            description: obj.description || '',
            method: 'ld_json',
          };
          break;
        }
      }
    } catch (_) {}
  });
  return result;
}

// Strategy C: ?__a=1 JSON endpoint (Instagram's internal API)
async function tryA1Endpoint(shortcode) {
  const url = `https://www.instagram.com/p/${shortcode}/?__a=1&__d=dis`;
  const res = await axios.get(url, {
    headers: { ...BROWSER_HEADERS, 'X-Requested-With': 'XMLHttpRequest' },
    maxRedirects: 5,
    timeout: 15_000,
  });
  if (isLoginRedirect(res.request?.res?.responseUrl)) {
    throw Object.assign(new Error('Private post'), { code: 'PRIVATE' });
  }
  const data = res.data;
  const videoUrl =
    data?.items?.[0]?.video_url ||
    data?.graphql?.shortcode_media?.video_url;
  if (!videoUrl) return null;
  const caption =
    data?.items?.[0]?.caption?.text ||
    data?.graphql?.shortcode_media?.edge_media_to_caption?.edges?.[0]?.node?.text ||
    '';
  return {
    videoUrl,
    thumbnail:
      data?.items?.[0]?.image_versions2?.candidates?.[0]?.url ||
      data?.graphql?.shortcode_media?.display_url ||
      '',
    title: caption.slice(0, 120),
    description: caption,
    method: 'a1_endpoint',
  };
}

// Strategy D: window._sharedData inline script
async function trySharedData(shortcode) {
  const url = `https://www.instagram.com/p/${shortcode}/`;
  const res = await axios.get(url, {
    headers: BROWSER_HEADERS,
    maxRedirects: 5,
    timeout: 15_000,
  });
  if (isLoginRedirect(res.request?.res?.responseUrl)) {
    throw Object.assign(new Error('Private post'), { code: 'PRIVATE' });
  }
  const match = res.data.match(/window\._sharedData\s*=\s*(\{.+?\});\s*<\/script>/s);
  if (!match) return null;
  let parsed;
  try { parsed = JSON.parse(match[1]); } catch (_) { return null; }
  const media = parsed?.entry_data?.PostPage?.[0]?.graphql?.shortcode_media;
  if (!media?.video_url) return null;
  const caption = media.edge_media_to_caption?.edges?.[0]?.node?.text || '';
  return {
    videoUrl: media.video_url,
    thumbnail: media.display_url || '',
    title: caption.slice(0, 120),
    description: caption,
    method: 'shared_data',
  };
}

// Strategy E: Instagram GraphQL public query endpoint
async function tryGraphQL(shortcode) {
  const QUERY_HASH = '2b0673e0dc4580674a88d426fe00ea90'; // shortcode_media hash
  const url =
    `https://www.instagram.com/graphql/query/?query_hash=${QUERY_HASH}` +
    `&variables=${encodeURIComponent(JSON.stringify({ shortcode }))}`;
  const res = await axios.get(url, {
    headers: { ...BROWSER_HEADERS, 'X-Requested-With': 'XMLHttpRequest' },
    maxRedirects: 5,
    timeout: 15_000,
  });
  if (isLoginRedirect(res.request?.res?.responseUrl)) {
    throw Object.assign(new Error('Private post'), { code: 'PRIVATE' });
  }
  const media = res.data?.data?.shortcode_media;
  if (!media?.video_url) return null;
  const caption = media.edge_media_to_caption?.edges?.[0]?.node?.text || '';
  return {
    videoUrl: media.video_url,
    thumbnail: media.display_url || '',
    title: caption.slice(0, 120),
    description: caption,
    method: 'graphql',
  };
}

// ─── 5. MASTER EXTRACTOR ──────────────────────────────────────────────────────

async function extractVideoInfo(postUrl) {
  const shortcode = extractShortcode(postUrl);
  if (!shortcode) throw new Error('Could not parse shortcode from URL');

  const strategies = [
    { name: 'og_meta',     fn: () => tryOgMeta(shortcode) },
    { name: 'ld_json',     fn: () => tryLdJson(shortcode) },
    { name: 'a1_endpoint', fn: () => tryA1Endpoint(shortcode) },
    { name: 'shared_data', fn: () => trySharedData(shortcode) },
    { name: 'graphql',     fn: () => tryGraphQL(shortcode) },
  ];

  let lastErr = null;
  for (let i = 0; i < strategies.length; i++) {
    const { name, fn } = strategies[i];
    if (i > 0) await sleep(800); // polite gap between retries
    try {
      const result = await fn();
      if (result?.videoUrl) {
        console.log(`[✓] extracted via ${name}  shortcode=${shortcode}`);
        return result;
      }
      console.log(`[–] ${name}: no videoUrl found, trying next`);
    } catch (err) {
      if (err.code === 'PRIVATE') throw err; // stop immediately for private posts
      console.log(`[✗] ${name}: ${err.message}`);
      lastErr = err;
    }
  }
  throw lastErr || new Error('All 5 extraction strategies failed');
}

// ─── 6. AUTH MIDDLEWARE ───────────────────────────────────────────────────────

function requireApiKey(req, res, next) {
  const key = req.headers['x-api-key'] || req.query.api_key;
  if (!key || key !== API_KEY) {
    return res.status(401).json({ error: 'Invalid or missing API key.' });
  }
  next();
}

// ─── 7. ROUTES ────────────────────────────────────────────────────────────────

// Health check — no auth required
app.get('/', (_req, res) => {
  res.json({
    status: 'ok',
    service: 'InstaSave API',
    version: '1.0.0',
    strategies: ['og_meta', 'ld_json', 'a1_endpoint', 'shared_data', 'graphql'],
  });
});

// Shared handler for POST /api/extract and GET /api/extract
async function handleExtract(req, res) {
  const url = (req.method === 'POST' ? req.body?.url : req.query?.url) || '';

  if (!url) {
    return res.status(400).json({ error: 'Missing required field: url' });
  }
  if (!isValidInstagramUrl(url)) {
    return res.status(400).json({
      error: 'Invalid Instagram URL. Must be /p/, /reel/, /tv/, or /reels/ link.',
    });
  }

  try {
    const data = await extractVideoInfo(url.trim());
    return res.json({ success: true, data });
  } catch (err) {
    if (err.code === 'PRIVATE') {
      return res.status(403).json({ error: 'This post is private or requires login.' });
    }
    if (err.response?.status === 429) {
      return res.status(429).json({
        error: 'Instagram is rate-limiting this server. Try again in a minute.',
      });
    }
    console.error('[fatal]', err.message);
    return res.status(500).json({
      error: 'All extraction strategies failed.',
      detail: err.message,
    });
  }
}

app.post('/api/extract', requireApiKey, handleExtract);
app.get('/api/extract', requireApiKey, handleExtract);

// ─── 8. START ─────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`\nInstaSave API running → http://localhost:${PORT}`);
  console.log(`POST /api/extract  { "url": "https://instagram.com/reel/..." }`);
  console.log(`Header required:   x-api-key: ${API_KEY.slice(0, 8)}...\n`);
});
