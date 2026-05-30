'use strict';

const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const rateLimit = require('express-rate-limit');

// ─── API Key ──────────────────────────────────────────────────────────────────
const DEFAULT_KEY = 'b4fc4efbf972ddd28753c4d315fd9437daa4c04747efd0e7223075da55b0f8d3';
const API_KEY = process.env.API_KEY || DEFAULT_KEY;
const PORT = process.env.PORT || 3000;

// ─── yt-dlp binary path (downloaded during Render build) ─────────────────────
const YTDLP_BIN = path.join(__dirname, 'yt-dlp');
const ytdlpAvailable = fs.existsSync(YTDLP_BIN);
console.log(`[yt-dlp] binary ${ytdlpAvailable ? 'found ✓' : 'NOT found — skipping yt-dlp strategy'}`);

// ─── Express ──────────────────────────────────────────────────────────────────
const app = express();
app.use(express.json());
app.use(rateLimit({
  windowMs: 60_000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (_req, res) => res.status(429).json({ error: 'Too many requests. Please wait a moment.' }),
}));

// ─── Headers ──────────────────────────────────────────────────────────────────
const BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept-Language': 'en-US,en;q=0.9',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Encoding': 'gzip, deflate, br',
  'Cache-Control': 'no-cache',
  'sec-fetch-dest': 'document',
  'sec-fetch-mode': 'navigate',
  'sec-fetch-site': 'none',
};

// ─── Helpers ──────────────────────────────────────────────────────────────────
function extractShortcode(url) {
  const m = url.match(/(?:instagram\.com|instagr\.am)\/(?:p|reel|tv|reels)\/([A-Za-z0-9_-]+)/);
  return m ? m[1] : null;
}

function isValidInstagramUrl(url) {
  return /^https?:\/\/(www\.)?(instagram\.com|instagr\.am)\/(p|reel|tv|reels)\/[A-Za-z0-9_-]+/.test(url.trim());
}

function isLoginRedirect(url = '') {
  return url.includes('/accounts/login/') || url.includes('/challenge/');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function unescape(s) {
  return (s || '').replace(/\\u0026/g, '&').replace(/\\\//g, '/').replace(/\\n/g, '').replace(/\\/g, '');
}

// ─── Strategy 1: yt-dlp via execFile ─────────────────────────────────────────
async function tryYtDlp(postUrl) {
  if (!ytdlpAvailable) return null;

  return new Promise((resolve, reject) => {
    execFile(
      YTDLP_BIN,
      ['--dump-json', '--no-playlist', '--socket-timeout', '20', postUrl],
      { timeout: 40_000, maxBuffer: 10 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) return reject(new Error(stderr || err.message));
        try {
          const data = JSON.parse(stdout.trim());

          // Pick best video URL
          let videoUrl = data.url || null;
          if (!videoUrl && Array.isArray(data.formats)) {
            const videos = data.formats.filter(f => f.url && f.vcodec && f.vcodec !== 'none');
            const mp4 = videos.filter(f => f.ext === 'mp4');
            const pool = mp4.length ? mp4 : videos;
            pool.sort((a, b) => (b.height || 0) - (a.height || 0));
            videoUrl = pool[0]?.url || null;
          }

          if (!videoUrl) return resolve(null);

          const desc = data.description || data.title || '';
          resolve({
            videoUrl,
            thumbnail: data.thumbnail || '',
            title: (data.title || desc).slice(0, 120),
            description: desc,
            method: 'yt_dlp',
          });
        } catch (e) {
          reject(e);
        }
      }
    );
  });
}

// ─── Strategy 2: Instagram embed page ────────────────────────────────────────
async function tryEmbedPage(shortcode) {
  const urls = [
    `https://www.instagram.com/reel/${shortcode}/embed/captioned/?cr=1&v=14&rd=https%3A%2F%2Fwww.instagram.com`,
    `https://www.instagram.com/p/${shortcode}/embed/captioned/?cr=1&v=14&rd=https%3A%2F%2Fwww.instagram.com`,
  ];

  for (const url of urls) {
    try {
      const res = await axios.get(url, {
        headers: {
          ...BROWSER_HEADERS,
          'Referer': 'https://www.instagram.com/',
          'sec-fetch-dest': 'iframe',
          'sec-fetch-site': 'same-origin',
        },
        maxRedirects: 5,
        timeout: 15_000,
      });

      if (isLoginRedirect(res.request?.res?.responseUrl)) continue;
      const html = res.data;

      const videoPatterns = [
        /"video_url"\s*:\s*"(https?[^"\\]+)"/,
        /"VideoUrl"\s*:\s*"(https?[^"\\]+)"/,
        /"playable_url"\s*:\s*"(https?[^"\\]+)"/,
        /"playable_url_quality_hd"\s*:\s*"(https?[^"\\]+)"/,
        /src=\\"(https?[^"\\]+\.mp4[^"\\]*)\\"/,
        /<video[^>]+src="(https?[^"]+)"/,
      ];

      for (const pat of videoPatterns) {
        const m = html.match(pat);
        if (m) {
          const videoUrl = unescape(m[1]);
          if (videoUrl.includes('cdninstagram') || videoUrl.includes('fbcdn.net') || videoUrl.includes('.mp4')) {
            const $ = cheerio.load(html);
            const thumbnail = $('meta[property="og:image"]').attr('content') || '';
            const title = ($('meta[property="og:title"]').attr('content') || '').slice(0, 120);
            return { videoUrl, thumbnail, title, description: title, method: 'embed_page' };
          }
        }
      }

      // Try ld+json in the embed page
      const $ = cheerio.load(html);
      let result = null;
      $('script[type="application/ld+json"]').each((_i, el) => {
        if (result) return;
        try {
          const json = JSON.parse($(el).html() || '{}');
          const items = Array.isArray(json) ? json : [json];
          for (const obj of items) {
            const videoUrl = obj.contentUrl || obj.video?.contentUrl ||
              (Array.isArray(obj.video) ? obj.video[0]?.contentUrl : null);
            if (videoUrl) {
              result = {
                videoUrl,
                thumbnail: obj.thumbnailUrl || obj.image || '',
                title: (obj.name || obj.headline || '').slice(0, 120),
                description: obj.description || '',
                method: 'embed_ldjson',
              };
            }
          }
        } catch (_) {}
      });
      if (result) return result;
    } catch (err) {
      if (err.code === 'PRIVATE') throw err;
    }
  }
  return null;
}

// ─── Strategy 3: og:video meta tag ───────────────────────────────────────────
async function tryOgMeta(shortcode) {
  const res = await axios.get(`https://www.instagram.com/p/${shortcode}/`, {
    headers: BROWSER_HEADERS, maxRedirects: 5, timeout: 15_000,
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
    title: ($('meta[property="og:title"]').attr('content') || '').slice(0, 120),
    description: $('meta[property="og:description"]').attr('content') || '',
    method: 'og_meta',
  };
}

// ─── Strategy 4: ld+json ──────────────────────────────────────────────────────
async function tryLdJson(shortcode) {
  const res = await axios.get(`https://www.instagram.com/p/${shortcode}/`, {
    headers: BROWSER_HEADERS, maxRedirects: 5, timeout: 15_000,
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
        const videoUrl = obj.contentUrl || obj.video?.contentUrl ||
          (Array.isArray(obj.video) ? obj.video[0]?.contentUrl : null);
        if (videoUrl) {
          result = {
            videoUrl,
            thumbnail: obj.thumbnailUrl || obj.image || '',
            title: (obj.name || obj.headline || '').slice(0, 120),
            description: obj.description || '',
            method: 'ld_json',
          };
        }
      }
    } catch (_) {}
  });
  return result;
}

// ─── Strategy 5: ?__a=1 ───────────────────────────────────────────────────────
async function tryA1Endpoint(shortcode) {
  const res = await axios.get(`https://www.instagram.com/p/${shortcode}/?__a=1&__d=dis`, {
    headers: { ...BROWSER_HEADERS, 'X-Requested-With': 'XMLHttpRequest' },
    maxRedirects: 5, timeout: 15_000,
  });
  if (isLoginRedirect(res.request?.res?.responseUrl)) {
    throw Object.assign(new Error('Private post'), { code: 'PRIVATE' });
  }
  const data = res.data;
  const videoUrl = data?.items?.[0]?.video_url || data?.graphql?.shortcode_media?.video_url;
  if (!videoUrl) return null;
  const caption = data?.items?.[0]?.caption?.text ||
    data?.graphql?.shortcode_media?.edge_media_to_caption?.edges?.[0]?.node?.text || '';
  return {
    videoUrl,
    thumbnail: data?.items?.[0]?.image_versions2?.candidates?.[0]?.url ||
      data?.graphql?.shortcode_media?.display_url || '',
    title: caption.slice(0, 120),
    description: caption,
    method: 'a1_endpoint',
  };
}

// ─── Strategy 6: _sharedData ──────────────────────────────────────────────────
async function trySharedData(shortcode) {
  const res = await axios.get(`https://www.instagram.com/p/${shortcode}/`, {
    headers: BROWSER_HEADERS, maxRedirects: 5, timeout: 15_000,
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

// ─── Strategy 7: GraphQL ──────────────────────────────────────────────────────
async function tryGraphQL(shortcode) {
  const QUERY_HASH = '2b0673e0dc4580674a88d426fe00ea90';
  const url = `https://www.instagram.com/graphql/query/?query_hash=${QUERY_HASH}&variables=${encodeURIComponent(JSON.stringify({ shortcode }))}`;
  const res = await axios.get(url, {
    headers: { ...BROWSER_HEADERS, 'X-Requested-With': 'XMLHttpRequest' },
    maxRedirects: 5, timeout: 15_000,
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

// ─── Master Extractor ─────────────────────────────────────────────────────────
async function extractVideoInfo(postUrl) {
  const shortcode = extractShortcode(postUrl);
  if (!shortcode) throw new Error('Could not parse shortcode from URL');

  const strategies = [
    { name: 'yt_dlp',      fn: () => tryYtDlp(postUrl) },
    { name: 'embed_page',  fn: () => tryEmbedPage(shortcode) },
    { name: 'og_meta',     fn: () => tryOgMeta(shortcode) },
    { name: 'ld_json',     fn: () => tryLdJson(shortcode) },
    { name: 'a1_endpoint', fn: () => tryA1Endpoint(shortcode) },
    { name: 'shared_data', fn: () => trySharedData(shortcode) },
    { name: 'graphql',     fn: () => tryGraphQL(shortcode) },
  ];

  let lastErr = null;
  for (let i = 0; i < strategies.length; i++) {
    const { name, fn } = strategies[i];
    if (i > 0) await sleep(500);
    try {
      const result = await fn();
      if (result?.videoUrl) {
        console.log(`[✓] ${name}  shortcode=${shortcode}`);
        return result;
      }
      console.log(`[–] ${name}: no videoUrl`);
    } catch (err) {
      if (err.code === 'PRIVATE') throw err;
      console.log(`[✗] ${name}: ${err.message}`);
      lastErr = err;
    }
  }
  throw lastErr || new Error('All extraction strategies failed');
}

// ─── Auth Middleware ──────────────────────────────────────────────────────────
function requireApiKey(req, res, next) {
  const key = req.headers['x-api-key'] || req.query.api_key;
  if (!key || key !== API_KEY) {
    return res.status(401).json({ error: 'Invalid or missing API key.' });
  }
  next();
}

// ─── Routes ───────────────────────────────────────────────────────────────────
app.get('/', (_req, res) => {
  res.json({ status: 'ok', service: 'InstaSave API', version: '2.1.0', ytdlp: ytdlpAvailable });
});

async function handleExtract(req, res) {
  const url = (req.method === 'POST' ? req.body?.url : req.query?.url) || '';
  if (!url) return res.status(400).json({ error: 'Missing required field: url' });
  if (!isValidInstagramUrl(url)) {
    return res.status(400).json({ error: 'Invalid Instagram URL. Must be /p/, /reel/, /tv/, or /reels/ link.' });
  }
  try {
    const data = await extractVideoInfo(url.trim());
    return res.json({ success: true, data });
  } catch (err) {
    if (err.code === 'PRIVATE') {
      return res.status(403).json({ error: 'This post is private or requires login.' });
    }
    if (err.response?.status === 429) {
      return res.status(429).json({ error: 'Instagram is rate-limiting this server. Try again in a minute.' });
    }
    console.error('[fatal]', err.message);
    return res.status(500).json({ error: 'All extraction strategies failed.', detail: err.message });
  }
}

app.post('/api/extract', requireApiKey, handleExtract);
app.get('/api/extract', requireApiKey, handleExtract);

// ─── Start ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\nInstaSave API v2.1 → http://localhost:${PORT}`);
  console.log(`yt-dlp: ${ytdlpAvailable ? 'available' : 'not found'}\n`);
});
