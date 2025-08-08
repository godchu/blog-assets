// utils.js
import * as cheerio from 'cheerio';
import path from 'path';
import { promises as fs } from 'node:fs';

/**
 * Clean a LINE store URL:
 * - Remove [brackets] and enclosed text
 * - Trim and take last whitespace-separated token
 */
function cleanUrl(raw) {
  const noBrackets = (raw || '').replace(/\[.*?\]/g, '').trim();
  const pieces = noBrackets.split(/\s+/);
  return pieces[pieces.length - 1] || '';
}

/**
 * Fetch helper that works in Node and the browser
 */
async function fetchHtml(url) {
  const res = await fetch(url, {
    headers: {
      // LINE blocks default bots; set a realistic UA
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome Safari',
    },
    cache: 'no-store',
    mode: 'no-cors',
  });

  if (!res.ok) throw new Error(`Failed to fetch store page: ${res.status}`);
  return await res.text();
}

/**
 * Parse a data-preview attribute into an object safely.
 * LINE often HTML-encodes quotes in this attribute.
 */
function parsePreviewAttr(attr) {
  if (!attr) return null;
  // Unescape common encodings
  const unescaped = attr
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
  try {
    return JSON.parse(unescaped);
  } catch {
    return null;
  }
}

/**
 * Normalize one sticker preview record to {id, url, type}
 */
function toStickerInfo(preview) {
  // preview may look like:
  // { id, staticUrl, animationUrl, type: 'STATIC' | 'ANIMATION' | 'SOUND' ... }
  const id = String(preview.id ?? preview.stickerId ?? '').trim();
  const hasAnim = !!preview.animationUrl;
  const url = hasAnim ? preview.animationUrl : preview.staticUrl || preview.url;
  const type = hasAnim ? 'ANIMATED' : 'STATIC';
  if (!id || !url) return null;
  return { id, url, type };
}

/**
 * Build a sticker info from a plain <img> when data-preview is missing.
 * Tries to extract the numeric id from filename or data attributes.
 */
function fromImg($img) {
  const url = $img.attr('data-src') || $img.attr('src') || $img.attr('data-original') || '';

  if (!url) return null;

  // Try to pull an ID from common LINE CDN paths
  // e.g. .../sticker/123456789/android/sticker.png
  const m = url.match(/\/sticker\/(\d+)\//);
  const id = m?.[1] || '';

  if (!id) return null;

  // Heuristic: animation variants often contain "animation" in the path/filename
  const isAnim = /animation/i.test(url);
  return { id, url, type: isAnim ? 'ANIMATED' : 'STATIC' };
}

/**
 * Scrape sticker info from a LINE Store product page
 * @param {string} storeUrl
 * @returns {Promise<Array<{id:string, url:string, type:'STATIC'|'ANIMATED'}>>}
 */
 async function getStickerInfo(storeUrl) {
  const cleaned = cleanUrl(storeUrl);
  if (!cleaned) return [];

  const html = await fetchHtml(cleaned);

  const $ = cheerio.load(html);

  const results = [];

  // 1) Primary path: elements with data-preview (most reliable)
  $('[data-preview]').each((_, el) => {
    const preview = parsePreviewAttr($(el).attr('data-preview'));
    const info = preview && toStickerInfo(preview);
    if (info) results.push(info);
  });

  // 2) Fallback: try common img selectors used on the product page
  if (results.length === 0) {
    // Sticker grid images
    $('li img, .mdCMN09Li img, .mdCMN09Image img, .FnStickerList img').each((_, img) => {
      const info = fromImg($(img));
      if (info) results.push(info);
    });
  }

  // Dedupe by id, prefer ANIMATED if both types exist
  const map = new Map();
  for (const item of results) {
    const prev = map.get(item.id);
    if (!prev) {
      map.set(item.id, item);
    } else if (prev.type === 'STATIC' && item.type === 'ANIMATED') {
      map.set(item.id, item);
    }
  }

  return Array.from(map.values());
}

// ==============================================

/** Fetch URL -> ArrayBuffer (Node 18+ has global fetch) */
 async function fetchArrayBuffer(url) {
  const res = await fetch(url, {
    headers: {
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome Safari',
    },
    cache: 'no-store',
  });
  if (!res.ok) throw new Error(`Fetch failed: ${res.status}`);
  return res.arrayBuffer();
}

/** If you specifically need a Node Buffer */
 async function fetchBuffer(url) {
  const ab = await fetchArrayBuffer(url);

  return Buffer.from(ab);
}

/** Buffer -> ArrayBuffer (handles offset correctly) */
 function bufferToArrayBuffer(buf) {
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

// =============================================

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome Safari';

function sanitize(segment) {
  return segment.replace(/[^a-zA-Z0-9._-]/g, '_');
}

async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

function fileNameFromUrl(u) {
  const url = new URL(u);
  // keep the original CDN filename; ignore query (?v=1)
  return sanitize(decodeURIComponent(path.basename(url.pathname)));
}

async function downloadOne(sticker, destDir) {
  const res = await fetch(sticker.url, {
    headers: { 'user-agent': UA },
    cache: 'no-store',
  });
  if (!res.ok) throw new Error(`Fetch failed ${sticker.id}: ${res.status}`);
  const ab = await res.arrayBuffer();
  const fileName = fileNameFromUrl(sticker.url);
  const filePath = path.join(destDir, fileName);
  await fs.writeFile(filePath, Buffer.from(ab));
  return filePath;
}

/**
 * Save stickers to /public/line-packs/<packId>/<stickerId>/<filename>
 * Returns a summary of saved paths.
 *
 * NOTE: On Vercel/serverless the filesystem is ephemeral. For durable storage,
 * swap to S3/GCS, or zip and return the file instead.
 */
// async function saveStickerPack(
//   packId,
//   stickers
// ) {
//   const baseDir = path.join(process.cwd(), 'line-packs', sanitize(packId));
//   await ensureDir(baseDir);

//   const results= [];
//   const errors = [];

//   // throttle a bit to avoid hammering the CDN
//   const concurrency = 6;
//   let i = 0;

//   async function worker() {
//     while (i < stickers.length) {
//       const idx = i++;
//       const s = stickers[idx];
//       const destDir = path.join(baseDir, sanitize(s.id));
//       try {
//         await ensureDir(destDir);
//         const savedPath = await downloadOne(s, destDir);
//         results.push({ id: s.id, path: savedPath });
//       } catch (e) {
//         errors.push({ id: s.id, error: e?.message || String(e) });
//       }
//     }
//   }

//   await Promise.all(Array.from({ length: concurrency }, worker));

//   return { baseDir, saved: results, failed: errors };
// }

async function saveStickerPack(packId, stickers) {
  const baseDir = path.join(process.cwd(), 'line-packs', sanitize(packId));
  await ensureDir(baseDir);

  const results = [];
  const errors = [];

  const concurrency = 6;
  let i = 0;

  async function worker() {
    while (i < stickers.length) {
      const idx = i++;
      const s = stickers[idx];
      try {
        // Always save as <stickerId>.png (keep extension from original if not png)
        const ext = path.extname(new URL(s.url).pathname) || '.png';
        const fileName = `${sanitize(s.id)}${ext}`;
        const filePath = path.join(baseDir, fileName);

        const res = await fetch(s.url, {
          headers: { 'user-agent': UA },
          cache: 'no-store',
        });
        if (!res.ok) throw new Error(`Fetch failed ${s.id}: ${res.status}`);
        const ab = await res.arrayBuffer();
        await fs.writeFile(filePath, Buffer.from(ab));

        results.push({
          id: s.id,
          path: path.join('line-packs', sanitize(packId), fileName),
        });
      } catch (e) {
        errors.push({ id: s.id, error: e?.message || String(e) });
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, worker));

  return {
    baseDir: path.join('line-packs', sanitize(packId)),
    saved: results,
    failed: errors,
  };
}


const STICKERS = [
  "https://store.line.me/emojishop/product/67c9092bcd372c3107c54c32/en",
  "https://store.line.me/emojishop/product/63ca068085d52f7ff12596d5/en",
  "https://store.line.me/emojishop/product/64e80b97092abe5833a87320/en",
  "https://store.line.me/emojishop/product/65e1933065bd7b66653c90f9/en",
  "https://store.line.me/emojishop/product/6808583169d7650139d3175a/en",
  "https://store.line.me/emojishop/product/667b809422d33233cb380c63/en",
  //
  "https://store.line.me/stickershop/product/27319218/en" 
]


STICKERS.forEach( async url => {
  const stickers = await getStickerInfo(url);

    const packId = stickers[0].id; 
    // Filter actual frames (skip the main.png entry if you want)
    const frames = stickers.filter(s => /^\d+$/.test(s.id));

    const res = await saveStickerPack(packId, frames);

    console.log(res);

})

