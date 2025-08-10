// // apng-to-gif.js
// import { createRequire } from 'node:module';
// import path from 'path';
// import { promises as fs } from 'node:fs';

// const require = createRequire(import.meta.url);
// const apng2gif = require('apng2gif');

// /**
//  * Convert an APNG file on disk to a GIF file on disk (async).
//  * @param {string} apngPath Absolute/relative path to .png APNG
//  * @param {string} gifPath  Output path to .gif
//  * @param {object} [opts]   apng2gif options (backgroundColor, transparencyThreshold, repeat, etc.)
//  * @returns {Promise<{out:string}>}
//  */
// export async function convertApngToGif(apngPath, gifPath, opts = {}) {
//   try {
//     // Ensure source exists
//     await fs.access(apngPath);

//     // Ensure destination directory exists
//     await fs.mkdir(path.dirname(gifPath), { recursive: true });

//     // Run conversion
//     await apng2gif(apngPath, gifPath, opts);

//     return { out: path.resolve(gifPath) };
//   } catch (e) {
//     throw new Error(`[convertApngToGif] Failed for ${apngPath} → ${gifPath}: ${e.message}`);
//   }
// }

// /**
//  * Sync version of convertApngToGif
//  */
// export function convertApngToGifSync(apngPath, gifPath, opts = {}) {
//   try {
//     apng2gif.sync(apngPath, gifPath, opts);
//     return { out: path.resolve(gifPath) };
//   } catch (e) {
//     throw new Error(`[convertApngToGifSync] Failed for ${apngPath} → ${gifPath}: ${e.message}`);
//   }
// }

// /**
//  * Convenience: takes a downloaded `_animation.png` file and makes a sibling `.gif`
//  */
// export async function convertApngVariantToGif(apngFileAbs, opts = {}) {
//   const dir = path.dirname(apngFileAbs);
//   const base = path.basename(apngFileAbs, path.extname(apngFileAbs));
//   const out = path.join(dir, `${base}.gif`);
//   return convertApngToGif(apngFileAbs, out, opts);
// }



// apng-to-gif.js (ESM)
import path from 'path';
import { promises as fs } from 'node:fs';
import UPNG from 'upng-js';
import { Gif, GifFrame, BitmapImage } from 'gifwrap';

const  { decode, toRGBA8} = UPNG

/**
 * @typedef {Object} GifOptions
 * @property {number} [repeat=0]         // 0=infinite, 1+=exact loop count
 * @property {number} [colorCount=256]   // 2..256
 * @property {number} [maxFrameDelayMs]  // clamp per-frame delay (ms), optional
 * @property {'throw'|'skip'} [onFrameError='throw'] // skip bad frames or throw
 */

const PNG_SIG = Buffer.from([0x89,0x50,0x4E,0x47,0x0D,0x0A,0x1A,0x0A]);
const isPngSig = (buf) => buf.length >= 8 && buf.subarray(0,8).equals(PNG_SIG);

async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

function toCentis(delayMs, maxFrameDelayMs) {
  const ms = typeof maxFrameDelayMs === 'number'
    ? Math.min(delayMs || 0, maxFrameDelayMs)
    : (delayMs || 0);
  // GIF delay is in centiseconds; clamp to at least 1 cs so it animates
  return Math.max(1, Math.round(ms / 10));
}

/**
 * Core: APNG bytes -> GIF Buffer (gifwrap)
 * @param {ArrayBuffer} ab
 * @param {GifOptions} opts
 * @returns {Promise<Buffer>}
 */
async function apngArrayBufferToGifBuffer(ab, opts = {}) {
  const {
    repeat = 0,
    colorCount = 256,
    maxFrameDelayMs,
    onFrameError = 'throw',
  } = opts;

  // Decode APNG
  let img;
  try {
    img = decode(ab);
  } catch (e) {
    throw new Error(`decode() failed: ${e?.message || e}`);
  }
  if (!img || typeof img.width !== 'number' || typeof img.height !== 'number') {
    throw new Error(`Invalid APNG meta (no width/height).`);
  }

  const w = img.width;
  const h = img.height;
  const frameCount = Array.isArray(img.frames) ? img.frames.length : 0;

  // Expand to full RGBA frames
  let rgbaFrames;
  try {
    rgbaFrames = toRGBA8(img); // Uint8Array[] (length = frameCount or 1 for static)
  } catch (e) {
    throw new Error(`toRGBA8() failed: ${e?.message || e}`);
  }

  const expected = Math.max(1, frameCount);
  if (!Array.isArray(rgbaFrames) || rgbaFrames.length !== expected) {
    throw new Error(`RGBA frames mismatch: frames=${frameCount}, rgba=${rgbaFrames?.length ?? 'N/A'}`);
  }

  // Build GifFrames
  const gifFrames = [];
  if (frameCount === 0) {
    // Static PNG
    const rgba = rgbaFrames[0];
    if (!rgba || rgba.length !== w * h * 4) {
      throw new Error(`Static frame invalid RGBA size.`);
    }
    const bmp = new BitmapImage({ width: w, height: h, data: Buffer.from(rgba) });
    gifFrames.push(new GifFrame(bmp, { delayCentisecs: 10 }));
  } else {
    for (let i = 0; i < frameCount; i++) {
      try {
        const f = img.frames[i] || {};
        const rgba = rgbaFrames[i];
        if (!rgba || rgba.length !== w * h * 4) {
          throw new Error(`frame[${i}] RGBA size=${rgba?.length}, expected=${w*h*4}`);
        }
        const bmp = new BitmapImage({ width: w, height: h, data: Buffer.from(rgba) });
        const dcs = toCentis(f.delay || 0, maxFrameDelayMs);
        gifFrames.push(new GifFrame(bmp, { delayCentisecs: dcs }));
      } catch (e) {
        if (onFrameError === 'skip') {
          // skip this frame quietly
          continue;
        }
        throw new Error(`Building frame[${i}] failed: ${e?.message || e}`);
      }
    }
    if (gifFrames.length === 0) {
      throw new Error(`No valid frames to encode.`);
    }
  }

  // Encode GIF
  try {
    const gif = new Gif(gifFrames, {
      loopCount: repeat === 0 ? 0 : repeat, // 0=infinite
      colorScope: 'per-frame',
      maxColors: Math.max(2, Math.min(256, colorCount)),
    });
    const encoded = await gif.encode();
    return Buffer.from(encoded.buffer);
  } catch (e) {
    const badIndex = gifFrames.findIndex((fr) => !fr || !fr.bitmap);
    const hint = badIndex >= 0 ? ` (bitmap missing at frame ${badIndex})` : '';
    throw new Error(`gifwrap encode() failed${hint}: ${e?.message || e}`);
  }
}

/**
 * Convert an APNG file on disk to a GIF file on disk.
 * @param {string} apngPath
 * @param {string} gifPath
 * @param {GifOptions} [opts]
 */
export async function convertApngToGif(apngPath, gifPath, opts = {}) {
  try {
    const buf = await fs.readFile(apngPath);
    if (!isPngSig(buf)) throw new Error(`Not a PNG signature: ${apngPath}`);
    const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);

    const gifBuf = await apngArrayBufferToGifBuffer(ab, opts);

    await ensureDir(path.dirname(gifPath));
    await fs.writeFile(gifPath, gifBuf);
    return { out: path.resolve(gifPath) };
  } catch (e) {
    throw new Error(`[convertApngToGif] ${apngPath} → ${gifPath} failed: ${e.message}`);
  }
}

/**
 * Convenience: takes a downloaded `_animation.png` and makes a sibling `.gif`.
 * @param {string} apngFileAbs
 * @param {GifOptions} [opts]
 */
export async function convertApngVariantToGif(apngFileAbs, opts = {}) {
  const dir = path.dirname(apngFileAbs);
  const base = path.basename(apngFileAbs, path.extname(apngFileAbs));
  const out = path.join(dir, `${base}.gif`);
  return convertApngToGif(apngFileAbs, out, opts);
}
