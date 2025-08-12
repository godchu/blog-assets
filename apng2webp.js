import sharp from 'sharp';
import  UPNG from 'upng-js';

import path from "path"

const { decode, toRGBA8 } = UPNG;

// Fetch APNG bytes

const download = async (url, wPath) => {
  const res = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0' } });
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
  const ab = await res.arrayBuffer();

  // Decode APNG -> frames (RGBA) + timing
  const apng = decode(ab);
  const rgbaFrames = toRGBA8(apng); // Array<ArrayBuffer>
  const { width, height } = apng;
  const n = rgbaFrames.length;

  // Build per-frame delays in ms (ensure a sane minimum)
  const delays = apng.frames.map(f => {
    // UPNG usually provides f.delay in ms; fall back to delayNum/Den if needed
    let ms = f.delay;
    if (ms == null) {
      const num = f.delayNum ?? 1;
      const den = f.delayDen ?? 10; // APNG default is 1/100s units
      ms = Math.round((num / den) * 1000);
    }
    return Math.max(10, ms); // avoid 0ms frames
  });

  // Stack frames vertically into one raw RGBA buffer
  const frameSize = width * height * 4;
  const stacked = Buffer.alloc(frameSize * n);
  for (let i = 0; i < n; i++) {
    Buffer.from(rgbaFrames[i]).copy(stacked, i * frameSize);
  }

  // Encode animated WebP
  await sharp(stacked, { raw: { width, height: height * n, channels: 4 } })
    .webp({
      quality: 90,        // tweak as you like; use lossless:true for lossless
      effort: 4,          // 0–6 encode effort
      loop: 0,            // 0 = infinite
      delay: delays,      // per-frame duration (ms)
      pageHeight: height, // tells sharp each "page" (frame) height
    })
    .toFile(wPath);

}

/** Convenience: *_animation.png -> *_animation.gif next to it */
export async function apngToWebpSibling(apngFileAbs, url) {
  const dir = path.dirname(apngFileAbs);
  const base = path.basename(apngFileAbs, path.extname(apngFileAbs));
  const wPath = path.join(dir, `${base}.webp`);
  return download(url, wPath);
}
