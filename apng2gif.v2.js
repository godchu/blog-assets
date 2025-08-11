// apng2gif.esm.js
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const apng2gif = require('apng2gif');

const execFileP = promisify(execFile);

function ffmpegUnimplemented(stderr = '') {
  return (
    stderr.includes('Not yet implemented in FFmpeg') ||
    stderr.includes('In-stream tag') ||
    stderr.includes('unspecified pixel format') ||
    stderr.includes('Could not find codec parameters') ||
    stderr.includes('Invalid data found when processing input')
  );
}

async function tryFfmpeg(apngPath, outGifPath) {
  const dir = path.dirname(outGifPath);
  const palette = path.join(dir, '___palette.tmp.png');

  // 1) palettegen (force rgba so ffmpeg knows the pixel format)
  const genArgs = [
    '-hide_banner', '-loglevel', 'error',
    '-probesize', '50M', '-analyzeduration', '50M',
    '-f', 'apng', '-i', apngPath,
    '-vf', 'format=rgba,palettegen=reserve_transparent=1',
    '-y', palette,
  ];
  try {
    await execFileP('ffmpeg', genArgs, { windowsHide: true });
  } catch (e) {
    const err = e?.stderr?.toString?.() || e?.message || '';
    if (ffmpegUnimplemented(err)) throw new Error('ffmpeg-not-implemented');
    throw new Error(`ffmpeg palettegen failed: ${err}`);
  }

  // 2) paletteuse (keep transparency, decent dithering)
  const useArgs = [
    '-hide_banner', '-loglevel', 'error',
    '-probesize', '50M', '-analyzeduration', '50M',
    '-f', 'apng', '-i', apngPath,
    '-i', palette,
    '-lavfi', 'format=rgba,paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle',
    '-y', outGifPath,
  ];
  try {
    await execFileP('ffmpeg', useArgs, { windowsHide: true });
  } catch (e) {
    const err = e?.stderr?.toString?.() || e?.message || '';
    if (ffmpegUnimplemented(err)) throw new Error('ffmpeg-not-implemented');
    throw new Error(`ffmpeg paletteuse failed: ${err}`);
  } finally {
    fs.unlink(palette).catch(() => {});
  }
}

/**
 * Convert APNG file -> GIF file. Tries ffmpeg first; falls back to apng2gif.
 * @param {string} apngPath
 * @param {string} outGifPath
 * @param {{ repeat?: number, colorCount?: number, backgroundColor?: string, transparencyThreshold?: number }} opts
 */
export async function apngToGif(apngPath, outGifPath, {
  repeat = 0,              // 0 = infinite loop
  colorCount = 256,        // 2..256
  backgroundColor,         // optional matte
  transparencyThreshold,   // optional (0..255)
} = {}) {
  await fs.mkdir(path.dirname(outGifPath), { recursive: true });

  // 1) Try ffmpeg (fast, great quality)
  try {
    await tryFfmpeg(apngPath, outGifPath);
    return { out: outGifPath };
  } catch (e) {
    console.warn('[ffmpeg] fallback to apng2gif:', e.message);
  }

  // 2) Fallback: apng2gif (handles tricky APNG chunks)
  await apng2gif(apngPath, outGifPath, {
    repeat,
    colorCount,
    backgroundColor,
    transparencyThreshold,
  });

  return { out: outGifPath };
}

/** Convenience: *_animation.png -> *_animation.gif next to it */
export const apngToGifSibling = async(apngFileAbs, opts) => {

  const dir = path.dirname(apngFileAbs);
  const base = path.basename(apngFileAbs, path.extname(apngFileAbs));
  const gifPath = path.join(dir, `${base}.gif`);
  return apngToGif(apngFileAbs, gifPath, opts);
}
