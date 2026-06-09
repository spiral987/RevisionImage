import type { EditorState, Operation, StrokePoint } from '../../types';
import type { OpHandler } from '../operation';
import { getLayer, replaceLayer } from '../editorState';
import { cloneLayer } from '../layer';
import { erasePixel } from '../imageBuffer';
import { rasterizeStroke } from '../strokeRaster';
import { clampBBox, padBBox, strokesBBox, unionBBox } from '../geom';
import { genId } from '../../util/id';

export interface EraserParams {
  size: number; // 直径(px)
  opacity: number; // 0..1（消去の強さ）
}

function sameParams(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  const pa = a as unknown as EraserParams;
  const pb = b as unknown as EraserParams;
  return pa.size === pb.size && pa.opacity === pb.opacity;
}

export const eraserHandler: OpHandler = {
  type: 'eraser',
  klass: 'brush',

  apply(state: EditorState, op: Operation): EditorState {
    const layer = getLayer(state, op.layerId);
    if (!layer) return state;
    const params = op.params as unknown as EraserParams;
    const newLayer = cloneLayer(layer);
    rasterizeStroke(
      newLayer.buffer,
      op.strokes ?? [],
      params.size / 2,
      layer.offsetX,
      layer.offsetY,
      (buf, x, y, cov) => erasePixel(buf, x, y, params.opacity * cov),
    );
    return replaceLayer(state, newLayer);
  },

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

export function createEraserOp(
  layerId: string,
  strokes: StrokePoint[],
  params: EraserParams,
  width: number,
  height: number,
): Operation {
  return {
    id: genId('eraser'),
    type: 'eraser',
    klass: 'brush',
    params: { size: params.size, opacity: params.opacity },
    region: clampBBox(padBBox(strokesBBox(strokes), params.size / 2 + 1), width, height),
    layerId,
    // 先頭点をサブストローク開始としてマーク（統合時に前操作との連結線を防ぐ）。
    strokes: strokes.map((p, i) => (i === 0 ? { ...p, down: true } : { ...p })),
    timestamp: Date.now(),
  };
}
