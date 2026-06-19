import type { ImageBuffer } from '../types';

/**
 * サムネの生成解像度倍率（表示サイズに対して）。高DPI 表示や軽いズームで滲まないよう ≥2、上限 3。
 * 重いのは flattenState（全レイヤ合成）で、これはサムネ寸法に依らず元々キャンバス解像度で実行＆キャッシュ済み。
 * 寸法を上げても増えるのは縮小 drawImage と PNG encode・保持メモリだけ（=軽い）。
 * bufferToDataURL は scale を 1 で頭打ちにするので、実解像度はキャンバス解像度が上限。
 */
export const THUMB_SCALE = Math.min(
  3,
  Math.max(2, Math.ceil((typeof window !== 'undefined' ? window.devicePixelRatio : 1) || 1)),
);

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
