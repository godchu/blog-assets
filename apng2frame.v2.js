// apng2frame.v2.js
import path from 'path';
import { promises as fs } from 'node:fs';
import pkg from 'upng-js';
import { localPathForUrl_V2, urlParts } from './helpers.js';

const { decode, toRGBA8, encode } = pkg;
const sanitize = (s) => String(s || '').replace(/[^a-zA-Z0-9._-]/g, '_');

const FETCH_HEADERS = {
  'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome Safari',
  'accept': 'image/apng,image/png,image/*;q=0.8,*/*;q=0.5',
  'referer': 'https://store.line.me/',
};

/**
 * Generate spritesheet + sticker.json into outDir
 */
export async function generateStickerFromAPNGUrlToFolder({
  apngUrl,
  outDir,
  spriteName = 'spritesheet.png',
  jsonName = 'sticker.json',
  cols = 8,
  padding = 0,
  label = 'Custom APNG animation',
  packName = 'My Sticker Pack',
  basePublicUrl,
  spriteRelPath,
  thumbRelPath,
}) {
  if (!apngUrl) throw new Error('apngUrl is required');
  if (!outDir) throw new Error('outDir is required');
  if (!basePublicUrl) throw new Error('basePublicUrl is required');
  if (!spriteRelPath) throw new Error('spriteRelPath is required');
  if (!thumbRelPath) throw new Error('thumbRelPath is required');

  await fs.mkdir(outDir, { recursive: true });

  // 1) Fetch APNG with stricter headers
  const res = await fetch(apngUrl, { headers: FETCH_HEADERS, cache: 'no-store' });
  if (!res.ok) throw new Error(`Fetch APNG failed ${res.status} for ${apngUrl}`);
  const ab = await res.arrayBuffer();
  const apngBuf = Buffer.from(ab);

  // 2) Decode (fail loudly if not PNG/APNG)
  let apng;
  try {
    apng = decode(apngBuf);
  } catch (e) {
    throw new Error(`UPNG.decode failed for ${apngUrl}: ${e?.message || e}`);
  }
  const rgbaFrames = toRGBA8(apng);
  const fw = apng.width, fh = apng.height, n = apng.frames.length;
  if (!n || !fw || !fh) throw new Error(`Decoded APNG has no frames/size: ${apngUrl}`);

  // 3) Compose spritesheet
  const rows = Math.ceil(n / cols);
  const W = cols * fw + (cols - 1) * padding;
  const H = rows * fh + (rows - 1) * padding;
  const sheet = new Uint8Array(W * H * 4);

  for (let k = 0; k < n; k++) {
    const fr = new Uint8Array(rgbaFrames[k]);
    const r = Math.floor(k / cols);
    const c = k % cols;
    const x = c * (fw + padding);
    const y = r * (fh + padding);
    for (let yOff = 0; yOff < fh; yOff++) {
      const srcRow = yOff * fw * 4;
      const dstRow = ((y + yOff) * W + x) * 4;
      sheet.set(fr.subarray(srcRow, srcRow + fw * 4), dstRow);
    }
  }

  // 4) Write files
  const spritePath = path.join(outDir, spriteName);
  const jsonPath = path.join(outDir, jsonName);

  const spriteAB = encode([sheet.buffer], W, H, 0);
  await fs.writeFile(spritePath, Buffer.from(spriteAB));

  const totalDelay = apng.frames.reduce((s, f) => s + (f.delay || 0), 0);
  const avgDelay = Math.round(totalDelay / Math.max(n, 1)) || 100;

  const spriteAbsUrl = (basePublicUrl + spriteRelPath).replace(/([^:]\/)\/+/g, '$1');
  const thumbAbsUrl  = (basePublicUrl + thumbRelPath).replace(/([^:]\/)\/+/g, '$1');

  const sticker = {
    frame_count: n,
    frame_rate: avgDelay,
    frames_per_column: cols,
    frames_per_row: rows,
    label,
    pack: { name: packName },
    sprite_image: { uri: spriteAbsUrl },
    image: { uri: thumbAbsUrl, width: fw, height: fh },
  };

  await fs.writeFile(jsonPath, JSON.stringify(sticker, null, 2), 'utf-8');

  return { sticker, spriteAbsUrl, thumbAbsUrl, spritePath, jsonPath };
}

/**
 * Build V2 — choose APNG frame, write under:
 *   line-packs-v2/<packId>/<stickerId>/<apngBase>/spritesheet.png & sticker.json
 */
// apng2frame.v2.js
export async function buildSpriteForPackV2({
  packId,
  frames,                   // Array<{id,url,type, staticUrl, fallbackStaticUrl}>
  basePublicDir,            // ABS repo root (e.g. process.cwd())
  basePublicUrl,            // 'https://raw.githubusercontent.com/godchu/blog-assets/refs/heads/main/'
  spriteName = 'spritesheet.png',
  jsonName = 'sticker.json',
  cols = 8,
  padding = 0,
  label = 'Sticker animation',
  packName = 'My Sticker Pack',
}) {
  if (!packId) throw new Error('packId is required');
  if (!Array.isArray(frames) || frames.length === 0) throw new Error('frames is empty');
  if (!basePublicDir) throw new Error('basePublicDir is required');
  if (!basePublicUrl) throw new Error('basePublicUrl is required');

  // Lấy TẤT CẢ APNG
  const apngFrames = frames.filter(f => f.type === 'ANIMATED' || /\.apng($|\?)/i.test(f.url));
  if (apngFrames.length === 0) {
    return { count: 0, results: [] };
  }

  const results = [];
  for (const apngFrame of apngFrames) {
    const stickerId = String(apngFrame.id);
    const { baseNoExt: apngBaseNoExt } = urlParts(apngFrame.url);

    // outDir tuyệt đối cho từng APNG
    const outDir = path.join(
      basePublicDir,
      'line-packs-v2',
      sanitize(packId),
      sanitize(stickerId),
      sanitize(apngBaseNoExt)
    );
    await fs.mkdir(outDir, { recursive: true });

    // đường dẫn tương đối để build URL
    const spriteRelPath = [
      'line-packs-v2',
      sanitize(packId),
      sanitize(stickerId),
      sanitize(apngBaseNoExt),
      spriteName,
    ].join('/');

    // thumb: ưu tiên staticUrl, sau đó fallbackStaticUrl, cuối cùng đành dùng chính apng url
    const staticCandidate = apngFrame.staticUrl || apngFrame.fallbackStaticUrl || apngFrame.url;
    const thumbRelPath = localPathForUrl_V2(packId, stickerId, staticCandidate);

    const one = await generateStickerFromAPNGUrlToFolder({
      apngUrl: apngFrame.url,
      outDir,
      spriteName,
      jsonName,
      cols,
      padding,
      label,
      packName,
      basePublicUrl,
      spriteRelPath,
      thumbRelPath,
    });

    results.push({
      stickerId,
      apngBase: apngBaseNoExt,
      ...one, // { sticker, spriteAbsUrl, thumbAbsUrl, spritePath, jsonPath }
    });
  }

  return { count: results.length, results };
}
