// utils.js
import * as cheerio from 'cheerio';
import path from 'path';
import { promises as fs } from 'node:fs';
import { buildSpriteForPackV2 } from './apng2frame.v2.js';
import { BASE_PUBLIC_URL, downloadTo, urlParts } from './helpers.js';
import { apngToGifSibling } from './apng2gif.v2.js';
import { apngToWebpSibling } from './apng2webp.js';

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
  return { 
    id, 
    url, 
    type, 
    staticUrl: preview.staticUrl || null,
    fallbackStaticUrl: preview.fallbackStaticUrl || null, 
  };
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
    // cache: 'no-store',
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
 * Save stickers to /public/line-packs-v2/<packId>/<stickerId>/<filename>
 * Returns a summary of saved paths.
 *
 * NOTE: On Vercel/serverless the filesystem is ephemeral. For durable storage,
 * swap to S3/GCS, or zip and return the file instead.
 */
// async function saveStickerPack(
//   packId,
//   stickers
// ) {
//   const baseDir = path.join(process.cwd(), 'line-packs-v2', sanitize(packId));
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

// --- FIXED: saveStickerPack (V2 structure, tải đủ animation/static/fallback) ---
// --- saveStickerPack V2: tải đủ animation/static/fallback ---
async function saveStickerPack(packId, stickers) {
  const relPackDir = path.join('line-packs-v2', sanitize(packId));
  const absPackDir = path.join(process.cwd(), relPackDir);
  await fs.mkdir(absPackDir, { recursive: true });

  const results = [];
  const errors = [];

  // chạy tuần tự cho dễ debug; muốn nhanh thì đổi sang worker/concurrency như cũ
  for (const s of stickers) {
    try {
      const urls = [
        s.animationUrl,
        s.url,               // url chính (đã ưu tiên animation trong toStickerInfo)
        s.staticUrl,
        s.fallbackStaticUrl,
      ]
        .filter(Boolean)
        .filter((v, i, arr) => arr.indexOf(v) === i); // uniq

      for (const oneUrl of urls) {
        const { baseNoExt, filename } = urlParts(oneUrl);

        // line-packs-v2/<packId>/<stickerId>/<filename-no-ext>/
        const relDir = path.join(relPackDir, sanitize(s.id), sanitize(baseNoExt));
        const absDir = path.join(process.cwd(), relDir);

        await downloadTo(oneUrl, absDir);

        if (/animation\.png(?:$|\?)/i.test(oneUrl)) {
          const apngPath = path.join(absDir, fileNameFromUrl(oneUrl)); // downloaded APNG
          // try {
          //   await apngToGifSibling(apngPath);
          // } catch (e) {
          //   console.warn('APNG→GIF failed for', apngPath, e?.message || e);
          // }

          try {
            await apngToWebpSibling(apngPath, oneUrl)
            
          } catch (error) {
            console.log(error);
            
          }
        }

        results.push({
          id: s.id,
          variantUrl: oneUrl,
          dir: relDir.replaceAll('\\', '/'),
          file: path.join(relDir, filename).replaceAll('\\', '/'),
        });
      }
    } catch (e) {
      errors.push({ id: s.id, error: e?.message || String(e) });
      console.error('saveStickerPack error:', s?.id, e);
    }
  }

  return { baseDir: relPackDir.replaceAll('\\', '/'), saved: results, failed: errors };
}

const STICKERS = [
  // "https://store.line.me/emojishop/product/67623b3dfeefbb031e01547f/en",
  // "https://store.line.me/emojishop/product/648e6812b74fae74142e8af0/en",
  // "https://store.line.me/emojishop/product/67c9092bcd372c3107c54c32/en",
  // "https://store.line.me/emojishop/product/63ca068085d52f7ff12596d5/en",
  // "https://store.line.me/emojishop/product/64e80b97092abe5833a87320/en",
  // "https://store.line.me/emojishop/product/65e1933065bd7b66653c90f9/en",
  // "https://store.line.me/emojishop/product/6808583169d7650139d3175a/en",
  // "https://store.line.me/emojishop/product/667b809422d33233cb380c63/en",
  // "https://store.line.me/emojishop/product/66d164f4ef749a3b57850c5c/en",
  // "https://store.line.me/emojishop/product/653c693f3a007919c0167e64/en",
  // "https://store.line.me/emojishop/product/665e825e22d33233cb37cea0/en",
  // "https://store.line.me/emojishop/product/65781a7a896d8c165265f3ea/en",
  "https://store.line.me/emojishop/product/686cb4907a295f1761c5ba83/en",
  // "https://store.line.me/stickershop/product/27319218/en",
]


export async function saveStickerPackSimple(packId, stickers) {
  const relPackDir = path.join('line-packs-simple', sanitize(packId));
  const absPackDir = path.join(process.cwd(), relPackDir);
  await ensureDir(absPackDir);

  const results = [];
  const errors = [];

  for (const s of stickers) {
    try {
      const bestUrl =
        s.animationUrl ||
        s.url ||
        s.staticUrl ||
        s.fallbackStaticUrl;

      if (!bestUrl) throw new Error('No URL for sticker');

      // Always save as <id>.png (APNG is still .png)
      const destRel = path.join(relPackDir, `${sanitize(String(s.id))}.png`);
      const destAbs = path.join(process.cwd(), destRel);

      const res = await fetch(bestUrl, {
        headers: { 'user-agent': UA },
        cache: 'no-store',
      });
      if (!res.ok) throw new Error(`Fetch failed ${s.id}: ${res.status}`);

      const ab = await res.arrayBuffer();
      await fs.writeFile(destAbs, Buffer.from(ab));

      results.push({
        id: String(s.id),
        url: bestUrl,
        file: destRel.replaceAll('\\', '/'),
      });
    } catch (e) {
      errors.push({ id: String(s?.id ?? ''), error: e?.message || String(e) });
      // optional: console.error('saveStickerPackSimple error:', s?.id, e);
    }
  }

  return {
    baseDir: relPackDir.replaceAll('\\', '/'),
    saved: results,
    failed: errors,
  };
}


STICKERS.forEach( async url => {
  const stickers = await getStickerInfo(url);

  const packId = stickers[0].id; 
  // Filter actual frames (skip the main.png entry if you want)
  const frames = stickers.filter(s => /^\d+$/.test(s.id));

  const res = await saveStickerPack(packId, frames);

  // Tạo sprite + json ngay trong cùng thư mục pack
  // await buildSpriteForPackV2({
  //   packId,
  //   frames,
  //   basePublicDir: process.cwd(),   // repo root
  //   basePublicUrl: BASE_PUBLIC_URL, // ✅ build absolute URL cho JSON
  //   spriteName: 'spritesheet.png',
  //   jsonName: 'sticker.json',
  //   cols: 8,
  //   padding: 0,
  //   label: 'Betakuma clapping',
  //   packName: "Betakkuma's Sports Frenzy",
  // });


  // const stickers = await getStickerInfo(url);
  // const packId = stickers[0].id;
  // const frames = stickers.filter(s => /^\d+$/.test(s.id));
  // await saveStickerPackSimple(packId, frames);

})
