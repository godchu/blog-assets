// apng2gif.esm.js
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { Gif, GifFrame, BitmapImage } from 'gifwrap';
import UPNG from 'upng-js';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const apng2gif = require('apng2gif'); // CJS, fine to require in ESM

const { decode, toRGBA8 } = UPNG;
const execFileP = promisify(execFile);

// ---- helpers
function ffmpegUnimplemented(stderr = '') {
  return (
    stderr.includes('Not yet implemented in FFmpeg') ||
    stderr.includes('In-stream tag') ||
    stderr.includes('unspecified pixel format') ||
    stderr.includes('Could not find codec parameters') ||
    stderr.includes('Invalid data found when processing input')
  );
}
const PNG_SIG = Buffer.from([0x89,0x50,0x4E,0x47,0x0D,0x0A,0x1A,0x0A]);
const isPngSigBuf = (buf) => buf?.length >= 8 && buf.subarray(0,8).equals(PNG_SIG);
const bufToAB = (b) => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
const toCS = (ms) => Math.max(1, Math.round((ms || 0) / 10));

async function tryFfmpeg(apngPath, outGifPath) {
  const dir = path.dirname(outGifPath);
  const palette = path.join(dir, '___palette.tmp.png');

  // palettegen
  const genArgs = [
    '-hide_banner','-loglevel','error',
    '-probesize','50M','-analyzeduration','50M',
    '-f','apng','-i', apngPath,
    '-vf','format=rgba,palettegen=reserve_transparent=1',
    '-y', palette,
  ];
  try {
    await execFileP('ffmpeg', genArgs, { windowsHide: true });
  } catch (e) {
    const err = e?.stderr?.toString?.() || e?.message || '';
    if (ffmpegUnimplemented(err)) throw new Error('ffmpeg-not-implemented');
    throw new Error(`ffmpeg palettegen failed: ${err}`);
  }

  // paletteuse
  const useArgs = [
    '-hide_banner','-loglevel','error',
    '-probesize','50M','-analyzeduration','50M',
    '-f','apng','-i', apngPath,
    '-i', palette,
    '-lavfi','format=rgba,paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle',
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

// ---- fallback #2: upng-js + gifwrap (with strict guards)
async function tryUpngGifwrap(apngPath, outGifPath, { loopCount = 0, maxFrameDelayMs, onFrameError = 'throw' } = {}) {
  const file = await fs.readFile(apngPath);
  if (!isPngSigBuf(file)) throw new Error('not-a-png-signature');

  let img;
  try {
    img = decode(bufToAB(file));
  } catch (e) {
    throw new Error(`decode-failed: ${e?.message || e}`);
  }
  if (!img || typeof img.width !== 'number' || typeof img.height !== 'number') {
    throw new Error('invalid-meta');
  }

  const w = img.width, h = img.height;
  let rgbaFrames;
  try {
    rgbaFrames = toRGBA8(img); // Uint8Array[]
  } catch (e) {
    throw new Error(`toRGBA8-failed: ${e?.message || e}`);
  }

  const frameCount = Array.isArray(img.frames) ? img.frames.length : 0;
  const expected = Math.max(1, frameCount);
  if (!Array.isArray(rgbaFrames) || rgbaFrames.length !== expected) {
    throw new Error(`rgba-mismatch: frames=${frameCount} rgba=${rgbaFrames?.length ?? 'N/A'}`);
  }

  const frames = [];
  if (frameCount === 0) {
    const rgba = rgbaFrames[0];
    if (!rgba || rgba.length !== w*h*4) throw new Error('static-bad-rgba');
    frames.push(new GifFrame(new BitmapImage({ width: w, height: h, data: Buffer.from(rgba) }), { delayCentisecs: 10 }));
  } else {
    for (let i = 0; i < frameCount; i++) {
      try {
        const rgba = rgbaFrames[i];
        if (!rgba || rgba.length !== w*h*4) throw new Error(`bad-rgba-size(${rgba?.length})`);
        const delayMs = img.frames[i]?.delay || 0;
        const d = typeof maxFrameDelayMs === 'number' ? Math.min(delayMs, maxFrameDelayMs) : delayMs;
        frames.push(new GifFrame(new BitmapImage({ width: w, height: h, data: Buffer.from(rgba) }), { delayCentisecs: toCS(d) }));
      } catch (e) {
        if (onFrameError === 'skip') continue;
        throw new Error(`build-frame[${i}]-failed: ${e?.message || e}`);
      }
    }
    if (!frames.length) throw new Error('no-valid-frames');
  }

  try {
    const gif = new Gif(frames, { loopCount, colorScope: 'per-frame', maxColors: 256 });
    const encoded = await gif.encode();
    await fs.writeFile(outGifPath, Buffer.from(encoded.buffer));
  } catch (e) {
    const badIndex = frames.findIndex((fr) => !fr || !fr.bitmap);
    const hint = badIndex >= 0 ? ` (bad frame at ${badIndex})` : '';
    throw new Error(`encode-failed${hint}: ${e?.message || e}`);
  }
}

// ---- fallback #3: apng2gif (tolerant, no loop control)
async function tryApng2gif(apngPath, outGifPath, { backgroundColor, transparencyThreshold } = {}) {
  await apng2gif(apngPath, outGifPath, {
    backgroundColor,
    transparencyThreshold,
  });
}

/**
 * Convert APNG file -> GIF file.
 * Order: ffmpeg → upng+gifwrap → apng2gif
 */
export async function apngToGif(
  apngPath,
  outGifPath,
  {
    // preferred loop in final GIF
    repeat = 0,                    // 0 = infinite
    maxFrameDelayMs,               // optional clamp
    onFrameError = 'throw',        // 'skip' to skip bad frames in UPNG path
    backgroundColor,               // only used by apng2gif fallback
    transparencyThreshold,         // only used by apng2gif fallback
  } = {}
) {
  await fs.mkdir(path.dirname(outGifPath), { recursive: true });

  // 1) ffmpeg fast path
  try {
    await tryFfmpeg(apngPath, outGifPath);
    return { out: outGifPath };
  } catch (e) {
    console.warn('[ffmpeg] fallback:', e.message);
  }

  // 2) upng-js + gifwrap (has loop control)
  try {
    await tryUpngGifwrap(apngPath, outGifPath, {
      loopCount: repeat === 0 ? 0 : repeat,
      maxFrameDelayMs,
      onFrameError,
    });
    return { out: outGifPath };
  } catch (e) {
    console.warn('[upng-gifwrap] fallback:', e.message);
  }

  // 3) apng2gif (very tolerant; no loop control)
  try {
    console.log('[apng2gif] fallback: using apng2gif: ');
    await tryApng2gif(apngPath, outGifPath, { backgroundColor, transparencyThreshold });
    return { out: outGifPath };
  } catch (e) {
    throw new Error(`[apng2gif] failed: ${e?.message || e}`);
  }
}

/** Convenience: *_animation.png -> *_animation.gif next to it */
export async function apngToGifSibling(apngFileAbs, opts) {
  const dir = path.dirname(apngFileAbs);
  const base = path.basename(apngFileAbs, path.extname(apngFileAbs));
  const gifPath = path.join(dir, `${base}.gif`);
  return apngToGif(apngFileAbs, gifPath, opts);
}
