import path from 'path';

import { promises as fs } from 'node:fs';


const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome Safari';

// helpers (đặt cùng file utils.js hoặc chỗ chung)
export const BASE_PUBLIC_URL = 'https://raw.githubusercontent.com/godchu/blog-assets/refs/heads/main/';

export function urlParts(u) {
  const url = new URL(u);
  const filename = decodeURIComponent(path.basename(url.pathname)); // ex: animation@2x.apng
  const baseNoExt = filename.replace(/\.[^.]+$/, '');
  return { filename, baseNoExt };
}

// Tạo relative path theo cấu trúc V2 bạn đã dùng khi save:
// line-packs-v2/<packId>/<stickerId>/<filename-no-ext>/<original-filename>
export function localPathForUrl_V2(packId, stickerId, fileUrl) {
  const { filename, baseNoExt } = urlParts(fileUrl);
  return path
    .join('line-packs-v2', sanitize(packId), sanitize(stickerId), sanitize(baseNoExt), filename)
    .replaceAll('\\', '/'); // ensure forward slashes on Windows
}

function sanitize(segment) {
  return segment.replace(/[^a-zA-Z0-9._-]/g, '_');
}


export async function downloadTo(fileUrl, absDir) {
  await fs.mkdir(absDir, { recursive: true });
  const { filename } = urlParts(fileUrl);
  const res = await fetch(fileUrl, { headers: { 'user-agent': UA }, cache: 'no-store' });
  if (!res.ok) throw new Error(`Fetch failed ${fileUrl}: ${res.status}`);
  const ab = await res.arrayBuffer();
  const absFile = path.join(absDir, filename);
  await fs.writeFile(absFile, Buffer.from(ab));
  return { absFile, filename };
}
