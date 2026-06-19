import type { BBox, ImageBuffer } from '../types';

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
 * フラット化済み ImageBuffer を縮小して dataURL(PNG) を返す（RevG/Board ノードのサムネイル用）。
 * region を渡すと「その変更領域だけ」を切り出してサムネにする（小さいサムネでも変更箇所が埋まり見やすい）。
 * 余白を少し足し、サムネのアスペクト(maxW:maxH)に合わせて広げる（レターボックスを避け文脈を残す）。
 */
export function bufferToDataURL(buf: ImageBuffer, maxW: number, maxH: number, region?: BBox | null): string {
  const src = document.createElement('canvas');
  src.width = buf.width;
  src.height = buf.height;
  const sctx = src.getContext('2d');
  if (!sctx) return '';
  const img = sctx.createImageData(buf.width, buf.height);
  img.data.set(buf.data);
  sctx.putImageData(img, 0, 0);

  // 既定は全体。region 指定時は「変更領域＋余白」をサムネのアスペクトに合わせて切り出す。
  let sx = 0;
  let sy = 0;
  let sw = buf.width;
  let sh = buf.height;
  if (region && region.w > 0 && region.h > 0) {
    const padX = Math.max(14, region.w * 0.18);
    const padY = Math.max(14, region.h * 0.18);
    let x0 = region.x - padX;
    let y0 = region.y - padY;
    let x1 = region.x + region.w + padX;
    let y1 = region.y + region.h + padY;
    const targetAR = maxW / maxH;
    const cx = (x0 + x1) / 2;
    const cy = (y0 + y1) / 2;
    const w = x1 - x0;
    const h = y1 - y0;
    if (w / h < targetAR) {
      const nw = h * targetAR;
      x0 = cx - nw / 2;
      x1 = cx + nw / 2;
    } else {
      const nh = w / targetAR;
      y0 = cy - nh / 2;
      y1 = cy + nh / 2;
    }
    x0 = Math.max(0, Math.floor(x0));
    y0 = Math.max(0, Math.floor(y0));
    x1 = Math.min(buf.width, Math.ceil(x1));
    y1 = Math.min(buf.height, Math.ceil(y1));
    sx = x0;
    sy = y0;
    sw = Math.max(1, x1 - x0);
    sh = Math.max(1, y1 - y0);
  }

  const scale = Math.min(maxW / sw, maxH / sh, 1);
  const dw = Math.max(1, Math.round(sw * scale));
  const dh = Math.max(1, Math.round(sh * scale));
  const dst = document.createElement('canvas');
  dst.width = dw;
  dst.height = dh;
  const dctx = dst.getContext('2d');
  if (!dctx) return '';
  dctx.imageSmoothingEnabled = true;
  dctx.drawImage(src, sx, sy, sw, sh, 0, 0, dw, dh);
  return dst.toDataURL();
}
