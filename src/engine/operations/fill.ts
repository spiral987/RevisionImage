import type { BBox, EditorState, ImageBuffer, Operation } from '../../types';
import type { OpHandler } from '../operation';
import { getLayer, replaceLayer } from '../editorState';
import { cloneLayer } from '../layer';
import { blendPixel } from '../imageBuffer';
import { clampBBox } from '../geom';
import { genId } from '../../util/id';

/**
 * 塗りつぶし（bucket / flood fill, klass=color）。種点と連結し色が許容差(tolerance)内の
 * 領域を塗り色で塗る。純TS・決定的なので log だけから replay できる。
 */
export interface FillParams {
  color: [number, number, number]; // 0..255
  opacity: number; // 0..1
  x: number; // キャンバス座標の種点
  y: number;
  tolerance: number; // 0..255（各チャネル差の許容）
}

interface MaskResult {
  mask: Uint8Array;
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** 種点(sx,sy はバッファローカル)から連結する許容差内画素のマスクと bbox を求める。 */
function computeMask(buffer: ImageBuffer, sx: number, sy: number, tol: number): MaskResult {
  const w = buffer.width;
  const h = buffer.height;
  const d = buffer.data;
  const mask = new Uint8Array(w * h);
  if (sx < 0 || sy < 0 || sx >= w || sy >= h) return { mask, minX: 0, minY: 0, maxX: -1, maxY: -1 };
  const si = (sy * w + sx) * 4;
  const t0 = d[si];
  const t1 = d[si + 1];
  const t2 = d[si + 2];
  const t3 = d[si + 3];
  let minX = sx;
  let minY = sy;
  let maxX = sx;
  let maxY = sy;
  const stack: number[] = [sy * w + sx];
  while (stack.length) {
    const p = stack.pop()!;
    if (mask[p]) continue;
    const i4 = p * 4;
    if (
      Math.abs(d[i4] - t0) > tol ||
      Math.abs(d[i4 + 1] - t1) > tol ||
      Math.abs(d[i4 + 2] - t2) > tol ||
      Math.abs(d[i4 + 3] - t3) > tol
    ) {
      continue;
    }
    mask[p] = 1;
    const px = p % w;
    const py = (p - px) / w;
    if (px < minX) minX = px;
    if (px > maxX) maxX = px;
    if (py < minY) minY = py;
    if (py > maxY) maxY = py;
    if (px > 0) stack.push(p - 1);
    if (px < w - 1) stack.push(p + 1);
    if (py > 0) stack.push(p - w);
    if (py < h - 1) stack.push(p + w);
  }
  return { mask, minX, minY, maxX, maxY };
}

export const fillHandler: OpHandler = {
  type: 'fill',
  klass: 'color',

  apply(state: EditorState, op: Operation): EditorState {
    const layer = getLayer(state, op.layerId);
    if (!layer) return state;
    const { color, opacity, x, y, tolerance } = op.params as unknown as FillParams;
    const w = layer.buffer.width;
    const sx = Math.floor(x) - Math.round(layer.offsetX);
    const sy = Math.floor(y) - Math.round(layer.offsetY);
    const { mask, maxX, minX } = computeMask(layer.buffer, sx, sy, tolerance);
    if (maxX < minX) return state; // 種点がバッファ外 → 何もしない

    const newLayer = cloneLayer(layer); // 画素を変更するのでバッファを複製
    const [fr, fg, fb] = color;
    for (let p = 0; p < mask.length; p++) {
      if (!mask[p]) continue;
      const px = p % w;
      blendPixel(newLayer.buffer, px, (p - px) / w, fr, fg, fb, opacity);
    }
    return replaceLayer(state, newLayer);
  },

  // 塗りつぶしは統合しない。
};

/** 塗りつぶしの影響領域（キャンバス座標 bbox）を事前に計算する（op.region・ハイライト用）。 */
export function fillRegion(
  state: EditorState,
  layerId: string,
  x: number,
  y: number,
  tolerance: number,
): BBox {
  const layer = getLayer(state, layerId);
  if (!layer) return { x: 0, y: 0, w: 0, h: 0 };
  const offX = Math.round(layer.offsetX);
  const offY = Math.round(layer.offsetY);
  const r = computeMask(layer.buffer, Math.floor(x) - offX, Math.floor(y) - offY, tolerance);
  if (r.maxX < r.minX) return { x: 0, y: 0, w: 0, h: 0 };
  return { x: r.minX + offX, y: r.minY + offY, w: r.maxX - r.minX + 1, h: r.maxY - r.minY + 1 };
}

export function createFillOp(
  layerId: string,
  color: [number, number, number],
  opacity: number,
  x: number,
  y: number,
  tolerance: number,
  region: BBox,
  width: number,
  height: number,
): Operation {
  return {
    id: genId('fill'),
    type: 'fill',
    klass: 'color',
    params: { color: [...color], opacity, x, y, tolerance },
    region: clampBBox(region, width, height),
    layerId,
    timestamp: Date.now(),
  };
}
