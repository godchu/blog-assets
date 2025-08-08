import fs from 'node:fs';
import pkg from 'upng-js';

const { decode, toRGBA8, encode } = pkg;

/**
 * Generate spritesheet PNG + sticker JSON from a remote APNG URL
 * @param {string} apngUrl - URL của APNG
 * @param {string} spriteOut - tên file PNG spritesheet xuất ra
 * @param {string} thumbOut - tên file thumbnail PNG (hoặc ảnh đại diện)
 * @param {number} cols - số frame trên mỗi hàng
 * @param {number} padding - khoảng cách pixel giữa các frame
 * @param {string} label - nhãn/tiêu đề sticker
 * @param {string} packName - tên gói sticker
 * @returns {Promise<object>} sticker JSON object
 */
export async function generateStickerFromAPNGUrl(
  apngUrl,
  spriteOut = 'sheet.png',
  thumbOut = 'thumb.png',
  cols = 8,
  padding = 0,
  label = 'Custom APNG animation',
  packName = 'My Sticker Pack'
) {
  // Fetch APNG từ URL
  const res = await fetch(apngUrl, {
    headers: {
      'user-agent': 'Mozilla/5.0', // tránh bị chặn
    },
  });
  if (!res.ok) throw new Error(`Fetch failed: ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());

  // Decode
  const apng = decode(buf);
  const rgbaFrames = toRGBA8(apng);

  const fw = apng.width;
  const fh = apng.height;
  const n = apng.frames.length;

  // Lưới
  const rows = Math.ceil(n / cols);
  const W = cols * fw + (cols - 1) * padding;
  const H = rows * fh + (rows - 1) * padding;
  const sheet = new Uint8Array(W * H * 4);

  // Ghép frame
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

  // Xuất spritesheet PNG
  const pngAB = encode([sheet.buffer], W, H, 0);
  fs.writeFileSync(spriteOut, Buffer.from(pngAB));

  // frame_rate trung bình
  const totalDelay = apng.frames.reduce((sum, f) => sum + (f.delay || 0), 0);
  const avgDelay = Math.round(totalDelay / n) || 100;

  // Object sticker
  const sticker = {
    frame_count: n,
    frame_rate: avgDelay,
    frames_per_column: cols,
    frames_per_row: rows,
    label,
    pack: { name: packName },
    sprite_image: { uri: spriteOut },
    image: { uri: thumbOut, width: fw, height: fh },
  };

  fs.writeFileSync('sticker.json', JSON.stringify(sticker, null, 2), 'utf-8');

  console.log(`✅ Spritesheet saved: ${spriteOut}`);
  console.log(`✅ JSON saved: sticker.json`);

  return sticker;
}

// Ví dụ chạy
(async () => {
  const sticker = await generateStickerFromAPNGUrl(
    'https://example.com/path/to/your.apng',
    'sheet.png',
    'thumb.png',
    8,
    0,
    'Betakuma clapping',
    "Betakkuma's Sports Frenzy"
  );
  console.log(sticker);
})();
