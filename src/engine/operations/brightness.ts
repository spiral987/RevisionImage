import type { BBox, EditorState, Operation } from '../../types';
import type { OpHandler } from '../operation';
import { getLayer, replaceLayer } from '../editorState';
import { cloneLayer } from '../layer';
import { fullCanvas } from '../geom';
import { genId } from '../../util/id';

export interface BrightnessParams {
  delta: number; // -255..255 を RGB に加算
}

export const brightnessHandler: OpHandler = {
  type: 'brightness',
  klass: 'color',

  apply(state: EditorState, op: Operation): EditorState {
    const layer = getLayer(state, op.layerId);
    if (!layer) return state;
    const { delta } = op.params as unknown as BrightnessParams;
    const newLayer = cloneLayer(layer);
    const d = newLayer.buffer.data;
    // Uint8ClampedArray は代入時に 0..255 へクランプ＆丸めする（整数 delta なので決定的）。
    for (let i = 0; i < d.length; i += 4) {
      d[i] = d[i] + delta;
      d[i + 1] = d[i + 1] + delta;
      d[i + 2] = d[i + 2] + delta;
    }
    return replaceLayer(state, newLayer);
  },

  // clamp により delta の加算は非結合（clamp(clamp(c+d1)+d2) ≠ clamp(c+d1+d2)）なので
  // 統合しない。UI はジェスチャ単位で1操作を emit するためログは肥大化しない。
};

export function createBrightnessOp(
  layerId: string,
  delta: number,
  width: number,
  height: number,
  region?: BBox,
): Operation {
  return {
    id: genId('brightness'),
    type: 'brightness',
    klass: 'color',
    params: { delta: Math.round(delta) },
    // 影響範囲。原論文の領域ベース依存判定のため、可能なら実際の内容領域を渡す（既定は全面）。
    region: region ?? fullCanvas(width, height),
    layerId,
    timestamp: Date.now(),
  };
}
