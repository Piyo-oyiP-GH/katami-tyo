// 写真のバイト列を読むだけの処理。ここでは画像を変換しない。
// 向き：API が EXIF の向きを自分で当てる（実測。向き 6 の架空の画像が正立して読めた）。だから回さない。
// 画質：Worker では JPEG を作り直せない。下げるのは端末の側で行う。

// API が受ける上限は base64 で 10,485,760 文字（実測のエラー文）。元の JPEG で約 7.86MB
export const API_IMAGE_LIMIT_BASE64 = 10 * 1024 * 1024;

// JPEG の EXIF から向きの値（1〜8）を読む。無ければ 1
export function exifOrientation(buf: ArrayBuffer): number {
  const v = new DataView(buf);
  if (v.byteLength < 4 || v.getUint16(0) !== 0xffd8) return 1;
  let p = 2;
  while (p + 4 <= v.byteLength) {
    const marker = v.getUint16(p);
    if ((marker & 0xff00) !== 0xff00 || marker === 0xffda) return 1;
    const size = v.getUint16(p + 2);
    if (marker === 0xffe1 && p + 10 <= v.byteLength && v.getUint32(p + 4) === 0x45786966) {
      return readTiffOrientation(v, p + 10, p + 2 + size);
    }
    p += 2 + size;
  }
  return 1;
}

function readTiffOrientation(v: DataView, tiff: number, end: number): number {
  if (tiff + 8 > v.byteLength) return 1;
  const little = v.getUint16(tiff) === 0x4949;
  const ifd = tiff + v.getUint32(tiff + 4, little);
  if (ifd + 2 > Math.min(end, v.byteLength)) return 1;
  const count = v.getUint16(ifd, little);
  for (let i = 0; i < count; i++) {
    const e = ifd + 2 + i * 12;
    if (e + 12 > v.byteLength) return 1;
    if (v.getUint16(e, little) === 0x0112) {
      const value = v.getUint16(e + 8, little);
      return value >= 1 && value <= 8 ? value : 1;
    }
  }
  return 1;
}
