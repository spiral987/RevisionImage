import type { EditorState, Operation, StrokePoint } from '../../types';
import type { OpHandler } from '../operation';
import { getLayer, replaceLayer } from '../editorState';
import { blendPixel, growBufferToInclude } from '../imageBuffer';
import { rasterizeStroke } from '../strokeRaster';
import { clampBBox, padBBox, strokesBBox, unionBBox } from '../geom';
import { genId } from '../../util/id';

export interface BrushParams {
  color: [number, number, number]; // 0..255
  size: number; // 直径(px)
  opacity: number; // 0..1
}

function sameParams(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  const pa = a as unknown as BrushParams;
  const pb = b as unknown as BrushParams;
  return (
    pa.size === pb.size &&
    pa.opacity === pb.opacity &&
    pa.color[0] === pb.color[0] &&
    pa.color[1] === pb.color[1] &&
    pa.color[2] === pb.color[2]
  );
}

export const brushHandler: OpHandler = {
  type: 'brush',
  klass: 'brush',

  apply(state: EditorState, op: Operation): EditorState {
    const layer = getLayer(state, op.layerId);
    if (!layer) return state;
    const strokes = op.strokes ?? [];
    if (strokes.length === 0) return state;
    const params = op.params as unknown as BrushParams;
    const radius = params.size / 2;

    // ストロークのレイヤローカル領域（= キャンバス座標 − 現オフセット）を内包するよう
    // バッファを拡張する。これにより非破壊移動(offset)後もキャンバス全面に描ける。
    const sb = strokesBBox(strokes);
    const pad = Math.ceil(radius) + 2;
    const grown = growBufferToInclude(
      layer.buffer,
      layer.offsetX,
      layer.offsetY,
      sb.x - layer.offsetX - pad,
      sb.y - layer.offsetY - pad,
      sb.x + sb.w - layer.offsetX + pad,
      sb.y + sb.h - layer.offsetY + pad,
    );

    const [r, g, b] = params.color;
    rasterizeStroke(grown.buffer, strokes, radius, grown.offsetX, grown.offsetY, (buf, x, y, cov) =>
      blendPixel(buf, x, y, r, g, b, params.opacity * cov),
    );
    return replaceLayer(state, {
      ...layer,
      buffer: grown.buffer,
      offsetX: grown.offsetX,
      offsetY: grown.offsetY,
    });
  },

  // 同一パラメータの連続ブラシは点列を連結して1操作に統合（SPEC 受け入れ条件）。
  // バッファ拡張を伴っても「逐次適用 == 統合1回適用」は厳密に成立する
  // （最終バッファ範囲 = 全ストローク領域の bounding box で結合的、合成順序も保存されるため）。
  consolidate(prev: Operation, next: Operation): Operation | null {
    if (prev.layerId !== next.layerId) return null;
    if (!sameParams(prev.params, next.params)) return null;
    return {
      ...prev,
      strokes: [...(prev.strokes ?? []), ...(next.strokes ?? [])],
      region: unionBBox(prev.region, next.region),
      timestamp: next.timestamp,
    };
  },
};

export function createBrushOp(
  layerId: string,
  strokes: StrokePoint[],
  params: BrushParams,
  width: number,
  height: number,
): Operation {
  return {
    id: genId('brush'),
    type: 'brush',
    klass: 'brush',
    params: { color: [...params.color], size: params.size, opacity: params.opacity },
    region: clampBBox(padBBox(strokesBBox(strokes), params.size / 2 + 1), width, height),
    layerId,
    // 先頭点をサブストローク開始としてマーク（統合時に前操作との連結線を防ぐ）。
    strokes: strokes.map((p, i) => (i === 0 ? { ...p, down: true } : { ...p })),
    timestamp: Date.now(),
  };
}
