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

  // プリマルチプライ・バイリニア標本化（境界外は透明）をピクセル毎にインライン展開する。
  // 旧実装は1画素あたり配列を5個確保していて GC 負荷で重かった。スカラー化で確保ゼロにする。
  // 演算順（top/bot）は旧実装と同一なので結果はビット一致。
  const sw = src.width;
  const sh = src.height;
  const sd = src.data;
  const out = createImageBuffer(nW, nH);
  const od = out.data;
  for (let uy = 0; uy < nH; uy++) {
    const cy = uy + nMinY + 0.5; // 出力ピクセル中心（キャンバス座標）
    for (let ux = 0; ux < nW; ux++) {
      const cx = ux + nMinX + 0.5;
      const bx = ia * cx + ic * cy + ie - ox - 0.5; // ソースバッファのピクセル中心座標
      const by = ib * cx + id * cy + iff - oy - 0.5;
      const x0 = Math.floor(bx);
      const y0 = Math.floor(by);
      const x1 = x0 + 1;
      const y1 = y0 + 1;
      const fx = bx - x0;
      const fy = by - y0;
      const x0ok = x0 >= 0 && x0 < sw;
      const x1ok = x1 >= 0 && x1 < sw;
      const y0ok = y0 >= 0 && y0 < sh;
      const y1ok = y1 >= 0 && y1 < sh;
      // 4近傍のプリマルチプライ済み rgb と生アルファ（範囲外は 0）。
      let r00 = 0, g00 = 0, b00 = 0, a00 = 0;
      let r10 = 0, g10 = 0, b10 = 0, a10 = 0;
      let r01 = 0, g01 = 0, b01 = 0, a01 = 0;
      let r11 = 0, g11 = 0, b11 = 0, a11 = 0;
      if (y0ok && x0ok) { const i = (y0 * sw + x0) * 4; const a = sd[i + 3], af = a / 255; r00 = sd[i] * af; g00 = sd[i + 1] * af; b00 = sd[i + 2] * af; a00 = a; }
      if (y0ok && x1ok) { const i = (y0 * sw + x1) * 4; const a = sd[i + 3], af = a / 255; r10 = sd[i] * af; g10 = sd[i + 1] * af; b10 = sd[i + 2] * af; a10 = a; }
      if (y1ok && x0ok) { const i = (y1 * sw + x0) * 4; const a = sd[i + 3], af = a / 255; r01 = sd[i] * af; g01 = sd[i + 1] * af; b01 = sd[i + 2] * af; a01 = a; }
      if (y1ok && x1ok) { const i = (y1 * sw + x1) * 4; const a = sd[i + 3], af = a / 255; r11 = sd[i] * af; g11 = sd[i + 1] * af; b11 = sd[i + 2] * af; a11 = a; }
      // バイリニア（top/bot）。
      const aTop = a00 + (a10 - a00) * fx;
      const aBot = a01 + (a11 - a01) * fx;
      const pa = aTop + (aBot - aTop) * fy;
      const di = (uy * nW + ux) * 4;
      if (pa <= 0) {
        od[di] = 0; od[di + 1] = 0; od[di + 2] = 0; od[di + 3] = 0;
        continue;
      }
      const rTop = r00 + (r10 - r00) * fx, rBot = r01 + (r11 - r01) * fx;
      const gTop = g00 + (g10 - g00) * fx, gBot = g01 + (g11 - g01) * fx;
      const bTop = b00 + (b10 - b00) * fx, bBot = b01 + (b11 - b01) * fx;
      const af = pa / 255;
      od[di] = Math.round((rTop + (rBot - rTop) * fy) / af);
      od[di + 1] = Math.round((gTop + (gBot - gTop) * fy) / af);
      od[di + 2] = Math.round((bTop + (bBot - bTop) * fy) / af);
      od[di + 3] = Math.round(pa);
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
