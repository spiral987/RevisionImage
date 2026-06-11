import type { BBox, EditorState, Layer, Operation } from '../../types';
import type { OpHandler } from '../operation';
import { getLayer, replaceLayer } from '../editorState';
import { createImageBuffer } from '../imageBuffer';
import { clampBBox, fullCanvas } from '../geom';
import { genId } from '../../util/id';

/**
 * 拡大・縮小・回転（および反転）を1つのアフィン変換としてレイヤー内容へ焼き込む操作（klass=deform）。
 * params はキャンバス座標上のアフィン行列: P' = (a*x + c*y + e, b*x + d*y + f)。
 * プリマルチプライ・バイリニアで再サンプルするので決定的（同入力→ビット同一）で replay できる。
 */
export interface TransformParams {
  a: number;
  b: number;
  c: number;
  d: number;
  e: number;
  f: number;
}

const MAX_DIM = 8192; // 暴走防止（極端な拡大時の上限）

/** プリマルチプライ・バイリニア標本化（境界外は透明）。x,y はソースバッファのピクセル中心座標。 */
function sample(src: { width: number; height: number; data: Uint8ClampedArray }, x: number, y: number): [number, number, number, number] {
  const { width: w, height: h, data: d } = src;
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;
  const at = (px: number, py: number): [number, number, number, number] => {
    if (px < 0 || py < 0 || px >= w || py >= h) return [0, 0, 0, 0];
    const i = (py * w + px) * 4;
    const a = d[i + 3] / 255;
    return [d[i] * a, d[i + 1] * a, d[i + 2] * a, d[i + 3]]; // premultiplied rgb, alpha 0..255
  };
  const c00 = at(x0, y0);
  const c10 = at(x0 + 1, y0);
  const c01 = at(x0, y0 + 1);
  const c11 = at(x0 + 1, y0 + 1);
  const out: [number, number, number, number] = [0, 0, 0, 0];
  for (let k = 0; k < 4; k++) {
    const top = c00[k] + (c10[k] - c00[k]) * fx;
    const bot = c01[k] + (c11[k] - c01[k]) * fx;
    out[k] = top + (bot - top) * fy;
  }
  const pa = out[3];
  if (pa <= 0) return [0, 0, 0, 0];
  const af = pa / 255;
  return [out[0] / af, out[1] / af, out[2] / af, pa];
}

function transformLayer(layer: Layer, m: TransformParams): Layer {
  const src = layer.buffer;
  const ox = layer.offsetX;
  const oy = layer.offsetY;
  // ソースバッファ全体の四隅（キャンバス座標）を変換して出力 bbox を求める。
  const corners: [number, number][] = [
    [ox, oy],
    [ox + src.width, oy],
    [ox + src.width, oy + src.height],
    [ox, oy + src.height],
  ];
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of corners) {
    const dx = m.a * x + m.c * y + m.e;
    const dy = m.b * x + m.d * y + m.f;
    if (dx < minX) minX = dx;
    if (dx > maxX) maxX = dx;
    if (dy < minY) minY = dy;
    if (dy > maxY) maxY = dy;
  }
  const det = m.a * m.d - m.b * m.c;
  if (Math.abs(det) < 1e-12) return layer; // 退化（潰れる）なら何もしない

  const nMinX = Math.floor(minX);
  const nMinY = Math.floor(minY);
  const nW = Math.min(MAX_DIM, Math.max(1, Math.ceil(maxX) - nMinX));
  const nH = Math.min(MAX_DIM, Math.max(1, Math.ceil(maxY) - nMinY));

  // 逆行列（出力キャンバス座標 → ソースキャンバス座標）。
  const ia = m.d / det;
  const ib = -m.b / det;
  const ic = -m.c / det;
  const id = m.a / det;
  const ie = -(ia * m.e + ic * m.f);
  const iff = -(ib * m.e + id * m.f);

  const out = createImageBuffer(nW, nH);
  const od = out.data;
  for (let uy = 0; uy < nH; uy++) {
    const cy = uy + nMinY + 0.5; // 出力ピクセル中心（キャンバス座標）
    for (let ux = 0; ux < nW; ux++) {
      const cx = ux + nMinX + 0.5;
      const sxCanvas = ia * cx + ic * cy + ie;
      const syCanvas = ib * cx + id * cy + iff;
      const bx = sxCanvas - ox - 0.5; // ソースバッファのピクセル中心座標
      const by = syCanvas - oy - 0.5;
      const [r, g, b, a] = sample(src, bx, by);
      const di = (uy * nW + ux) * 4;
      od[di] = Math.round(r);
      od[di + 1] = Math.round(g);
      od[di + 2] = Math.round(b);
      od[di + 3] = Math.round(a);
    }
  }
  return { ...layer, buffer: out, offsetX: nMinX, offsetY: nMinY };
}

export const transformHandler: OpHandler = {
  type: 'transform',
  klass: 'deform',
  apply(state: EditorState, op: Operation): EditorState {
    const layer = getLayer(state, op.layerId);
    if (!layer) return state;
    const m = op.params as unknown as TransformParams;
    return replaceLayer(state, transformLayer(layer, m));
  },
  // 変形は統合しない（再サンプルが非結合）。
};

export function createTransformOp(
  layerId: string,
  params: TransformParams,
  width: number,
  height: number,
  region?: BBox,
): Operation {
  return {
    id: genId('transform'),
    type: 'transform',
    klass: 'deform',
    params: { ...params },
    region: region ? clampBBox(region, width, height) : fullCanvas(width, height),
    layerId,
    timestamp: Date.now(),
  };
}
