import type { BBox, StrokePoint } from '../types';

/** 2つの bbox の和集合（包含する最小矩形）。 */
export function unionBBox(a: BBox, b: BBox): BBox {
  const x1 = Math.min(a.x, b.x);
  const y1 = Math.min(a.y, b.y);
  const x2 = Math.max(a.x + a.w, b.x + b.w);
  const y2 = Math.max(a.y + a.h, b.y + b.h);
  return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
}

/** bbox を pad だけ全方向に拡張する。 */
export function padBBox(b: BBox, pad: number): BBox {
  return { x: b.x - pad, y: b.y - pad, w: b.w + 2 * pad, h: b.h + 2 * pad };
}

/** bbox をキャンバス境界 [0,w]×[0,h] にクランプし、整数化する。 */
export function clampBBox(b: BBox, w: number, h: number): BBox {
  const x = Math.max(0, Math.floor(b.x));
  const y = Math.max(0, Math.floor(b.y));
  const x2 = Math.min(w, Math.ceil(b.x + b.w));
  const y2 = Math.min(h, Math.ceil(b.y + b.h));
  return { x, y, w: Math.max(0, x2 - x), h: Math.max(0, y2 - y) };
}

/** 点列を包含する bbox。 */
export function strokesBBox(strokes: StrokePoint[]): BBox {
  if (strokes.length === 0) return { x: 0, y: 0, w: 0, h: 0 };
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of strokes) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

/** キャンバス全体の bbox。 */
export function fullCanvas(w: number, h: number): BBox {
  return { x: 0, y: 0, w, h };
}
