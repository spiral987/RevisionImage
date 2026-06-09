import type { ImageBuffer } from '../types';

/**
 * フラット化済み ImageBuffer を縮小して dataURL(PNG) を返す（RevG ノードのサムネイル用）。
 * 元サイズの canvas に putImageData → 縮小先 canvas に drawImage（アスペクト比維持）。
 */
export function bufferToDataURL(buf: ImageBuffer, maxW: number, maxH: number): string {
  const src = document.createElement('canvas');
  src.width = buf.width;
  src.height = buf.height;
  const sctx = src.getContext('2d');
  if (!sctx) return '';
  const img = sctx.createImageData(buf.width, buf.height);
  img.data.set(buf.data);
  sctx.putImageData(img, 0, 0);

  const scale = Math.min(maxW / buf.width, maxH / buf.height, 1);
  const dw = Math.max(1, Math.round(buf.width * scale));
  const dh = Math.max(1, Math.round(buf.height * scale));
  const dst = document.createElement('canvas');
  dst.width = dw;
  dst.height = dh;
  const dctx = dst.getContext('2d');
  if (!dctx) return '';
  dctx.imageSmoothingEnabled = true;
  dctx.drawImage(src, 0, 0, dw, dh);
  return dst.toDataURL();
}
