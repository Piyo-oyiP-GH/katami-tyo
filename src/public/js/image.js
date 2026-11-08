// 端末の中の画像処理。原寸のまま送る。縮小するのは一覧用の画像とぼけの測定だけ。

export const MAX_PHOTO_BYTES = 5 * 1024 * 1024; // サーバの上限と同じ
const THUMB_LONG = 480;
const MEASURE_LONG = 1024;
const TILE = 64;

// ぼけと白飛びの目安。仮の値。scripts/app/calibrate-blur.mjs で、撮ったままの写真はほぼ high、
// 強いぼかしは low になることを確かめた。弱いぼけの扱いは、実機と T2c で見直す
export const SHARP_HIGH = 60;
export const SHARP_MID = 15;
export const CLIP_MID = 0.25;
export const CLIP_LOW = 0.5;
// 真ん中の下位 10% の値。背景の毛羽立ちに引っぱられない目安。ぼけると紙の余白のノイズまで消える。
// 実写真 65 枚：撮ったままは 1.3 以上。真ん中の 3 割四方だけ強くぼかすと 1.1 以下（calibrate-blur.mjs）。
// 弱いぼけ（12px）は一部しか拾えない。真ん中に物が無い写真も見逃す
export const CENTER_SOFT = 1.2;
export const GLARE_MID = 0.25; // 真ん中のタイルのうち、白飛びしたタイルの割合
const CENTER_FROM = 0.25; // 真ん中＝縦横の 25%〜75%。物は真ん中に置いて撮る
const CENTER_TO = 0.75;

const isJpeg = (b) => b[0] === 0xff && b[1] === 0xd8;

// JPEG の区切りを順に見る。SOS より後は画像の本体
function* segments(b) {
  let p = 2;
  while (p + 4 <= b.length && b[p] === 0xff) {
    const marker = b[p + 1];
    if (marker === 0xda) return;
    const len = (b[p + 2] << 8) | b[p + 3];
    yield { marker, start: p, end: p + 2 + len };
    p += 2 + len;
  }
}

// EXIF の向き。1 が正位置。無ければ 1
export function exifOrientation(b) {
  if (!isJpeg(b)) return 1;
  for (const s of segments(b)) {
    if (s.marker !== 0xe1) continue;
    const t = s.start + 10; // "Exif\0\0" の後ろ
    if (String.fromCharCode(...b.subarray(s.start + 4, s.start + 8)) !== "Exif") continue;
    const little = b[t] === 0x49;
    const view = new DataView(b.buffer, b.byteOffset);
    const u16 = (o) => view.getUint16(o, little);
    const u32 = (o) => view.getUint32(o, little);
    const ifd = t + u32(t + 4);
    const count = u16(ifd);
    for (let i = 0; i < count; i++) {
      const e = ifd + 2 + i * 12;
      if (u16(e) === 0x0112) return u16(e + 8);
    }
  }
  return 1;
}

// 向きだけを持つ、いちばん小さい EXIF の区切り
function orientationSegment(orientation) {
  return new Uint8Array([
    0xff, 0xe1, 0x00, 0x22, // 区切りの印と長さ
    0x45, 0x78, 0x69, 0x66, 0x00, 0x00, // "Exif\0\0"
    0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00, // TIFF の頭
    0x01, 0x00, // 項目 1 つ
    0x12, 0x01, 0x03, 0x00, 0x01, 0x00, 0x00, 0x00, orientation, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00,
  ]);
}

// EXIF を外す。位置の情報を送らないため。画像の本体には触らず、作り直さない。
// 向きは API と画面が EXIF を見て正すので、向きだけは残す
export function stripExif(b, orientation = 1) {
  const parts = [b.subarray(0, 2)];
  if (orientation > 1) parts.push(orientationSegment(orientation));
  let from = 2;
  for (const s of segments(b)) {
    if (s.marker !== 0xe1) continue;
    parts.push(b.subarray(from, s.start));
    from = s.end;
  }
  parts.push(b.subarray(from));
  return new Blob(parts, { type: "image/jpeg" });
}

function toCanvas(bitmap, scale = 1) {
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  const g = canvas.getContext("2d", { willReadFrequently: false });
  g.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  return canvas;
}

const toJpeg = (canvas, quality) =>
  new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));

// 原寸のまま JPEG にする。5MB を超えるときだけ画質を下げ、それでも無理なら少し小さくする
async function encodeWithin(bitmap, limit) {
  for (const scale of [1, 0.85, 0.7, 0.5]) {
    const canvas = toCanvas(bitmap, scale);
    for (const q of [0.92, 0.86, 0.8, 0.72, 0.64, 0.55]) {
      const blob = await toJpeg(canvas, q);
      if (blob && blob.size <= limit) return blob;
    }
  }
  return null;
}

// 画像の上限の判定。ぼけは、タイルごとのラプラシアン分散で見る。
// sharp は全体の上位 10%。紙の余白が広くても、文字のある所がくっきりしていれば「ぼけていない」と見る。
// center は真ん中の下位 10%。sharp だけだと、背景の布がくっきりしていれば、ぼけた紙を見逃す。
// glare は真ん中の白飛び。全体の割合だと、小さな紙の光りが薄まる
export function measure(bitmap) {
  const scale = Math.min(1, MEASURE_LONG / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  const w = (canvas.width = Math.max(1, Math.round(bitmap.width * scale)));
  const hgt = (canvas.height = Math.max(1, Math.round(bitmap.height * scale)));
  const g = canvas.getContext("2d", { willReadFrequently: true });
  g.drawImage(bitmap, 0, 0, w, hgt);
  const { data } = g.getImageData(0, 0, w, hgt);
  const gray = new Float32Array(w * hgt);
  let clipped = 0;
  for (let i = 0, p = 0; i < gray.length; i++, p += 4) {
    const y = 0.299 * data[p] + 0.587 * data[p + 1] + 0.114 * data[p + 2];
    gray[i] = y;
    if (y >= 250) clipped++;
  }
  const tiles = [];
  const middle = [];
  let glareTiles = 0;
  for (let ty = 1; ty + TILE < hgt; ty += TILE) {
    for (let tx = 1; tx + TILE < w; tx += TILE) {
      let sum = 0;
      let sq = 0;
      let bright = 0;
      for (let y = ty; y < ty + TILE; y++) {
        for (let x = tx; x < tx + TILE; x++) {
          const i = y * w + x;
          const lap = gray[i - 1] + gray[i + 1] + gray[i - w] + gray[i + w] - 4 * gray[i];
          sum += lap;
          sq += lap * lap;
          if (gray[i] >= 250) bright++;
        }
      }
      const n = TILE * TILE;
      const v = sq / n - (sum / n) ** 2;
      tiles.push(v);
      const cx = (tx + TILE / 2) / w;
      const cy = (ty + TILE / 2) / hgt;
      if (cx > CENTER_FROM && cx < CENTER_TO && cy > CENTER_FROM && cy < CENTER_TO) {
        middle.push(v);
        if (bright / n >= 0.5) glareTiles++;
      }
    }
  }
  tiles.sort((a, b) => a - b);
  middle.sort((a, b) => a - b);
  const sharp = tiles.length ? tiles[Math.floor(tiles.length * 0.9)] : 0;
  // 小さすぎて真ん中のタイルが取れない画像は、全体の値で見る
  const center = middle.length >= 4 ? middle[Math.floor((middle.length - 1) * 0.1)] : sharp;
  const glare = middle.length ? glareTiles / middle.length : 0;
  return { sharp, center, glare, clipped: clipped / gray.length };
}

export function ceilingOf({ sharp, center = Infinity, glare = 0, clipped }) {
  if (sharp < SHARP_MID || clipped >= CLIP_LOW) return "low";
  if (sharp < SHARP_HIGH || clipped >= CLIP_MID || center < CENTER_SOFT || glare >= GLARE_MID) return "mid";
  return "high";
}

async function makeThumb(bitmap) {
  const scale = Math.min(1, THUMB_LONG / Math.max(bitmap.width, bitmap.height));
  return toJpeg(toCanvas(bitmap, scale), 0.72);
}

// 撮った画像を、送る形に整える。返すのは { photo, thumb, ceiling, stats }
export async function prepare(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const bitmap = await createImageBitmap(blob); // EXIF の向きを反映して読む
  const stats = measure(bitmap);
  const orientation = exifOrientation(bytes);
  let photo = null;
  if (isJpeg(bytes)) photo = stripExif(bytes, orientation);
  // JPEG 以外か 5MB を超えるときだけ、原寸のまま作り直す。作り直すと向きは画素に反映される
  if (!photo || photo.size > MAX_PHOTO_BYTES) photo = await encodeWithin(bitmap, MAX_PHOTO_BYTES);
  const thumb = await makeThumb(bitmap);
  bitmap.close?.();
  if (!photo) throw new Error("encode_failed");
  return { photo, thumb, ceiling: ceilingOf(stats), stats };
}
