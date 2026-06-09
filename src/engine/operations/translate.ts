import type { BBox, EditorState, Operation } from '../../types';
import type { OpHandler } from '../operation';
import { getLayer, replaceLayer } from '../editorState';
import { cloneLayer } from '../layer';
import { fullCanvas, unionBBox } from '../geom';
import { genId } from '../../util/id';

export interface TranslateParams {
  dx: number;
  dy: number;
}

export const translateHandler: OpHandler = {
  type: 'translate',
  klass: 'rigid',

  apply(state: EditorState, op: Operation): EditorState {
    const layer = getLayer(state, op.layerId);
    if (!layer) return state;
    const { dx, dy } = op.params as unknown as TranslateParams;
    const newLayer = cloneLayer(layer, { cloneBuffer: false }); // バッファは不変、オフセットのみ
    newLayer.offsetX = layer.offsetX + dx;
    newLayer.offsetY = layer.offsetY + dy;
    return replaceLayer(state, newLayer);
  },

  // オフセットの加算は厳密に結合的なので統合可能（clamp なし）。
  consolidate(prev: Operation, next: Operation): Operation | null {
    if (prev.layerId !== next.layerId) return null;
    const p = prev.params as unknown as TranslateParams;
    const n = next.params as unknown as TranslateParams;
    return {
      ...prev,
      params: { dx: p.dx + n.dx, dy: p.dy + n.dy },
      region: unionBBox(prev.region, next.region),
      timestamp: next.timestamp,
    };
  },
};

export function createTranslateOp(
  layerId: string,
  dx: number,
  dy: number,
  width: number,
  height: number,
  region?: BBox,
): Operation {
  return {
    id: genId('translate'),
    type: 'translate',
    klass: 'rigid',
    params: { dx, dy },
    // 影響範囲 = 移動前後の内容領域の和（既定は全面）。
    region: region ?? fullCanvas(width, height),
    layerId,
    timestamp: Date.now(),
  };
}
