// apng-to-gif.js
import { createRequire } from 'node:module';
import path from 'path';
import { promises as fs } from 'node:fs';

const require = createRequire(import.meta.url);
const apng2gif = require('apng2gif');

/**
 * Convert an APNG file on disk to a GIF file on disk (async).
 * @param {string} apngPath Absolute/relative path to .png APNG
 * @param {string} gifPath  Output path to .gif
 * @param {object} [opts]   apng2gif options (backgroundColor, transparencyThreshold, repeat, etc.)
 * @returns {Promise<{out:string}>}
 */
export async function convertApngToGif(apngPath, gifPath, opts = {}) {
  try {
    // Ensure source exists
    await fs.access(apngPath);

    // Ensure destination directory exists
    await fs.mkdir(path.dirname(gifPath), { recursive: true });

    // Run conversion
    await apng2gif(apngPath, gifPath, opts);

    return { out: path.resolve(gifPath) };
  } catch (e) {
    throw new Error(`[convertApngToGif] Failed for ${apngPath} → ${gifPath}: ${e.message}`);
  }
}

/**
 * Sync version of convertApngToGif
 */
export function convertApngToGifSync(apngPath, gifPath, opts = {}) {
  try {
    apng2gif.sync(apngPath, gifPath, opts);
    return { out: path.resolve(gifPath) };
  } catch (e) {
    throw new Error(`[convertApngToGifSync] Failed for ${apngPath} → ${gifPath}: ${e.message}`);
  }
}

/**
 * Convenience: takes a downloaded `_animation.png` file and makes a sibling `.gif`
 */
export async function convertApngVariantToGif(apngFileAbs, opts = {}) {
  const dir = path.dirname(apngFileAbs);
  const base = path.basename(apngFileAbs, path.extname(apngFileAbs));
  const out = path.join(dir, `${base}.gif`);
  return convertApngToGif(apngFileAbs, out, opts);
}
