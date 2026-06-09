import type { EditorState, Operation } from '../../types';
import type { OpHandler } from '../operation';
import { createLayer } from '../layer';
import { fullCanvas } from '../geom';
import { genId } from '../../util/id';

export interface AddLayerParams {
  layerId: string; // 新規レイヤのID（ログに保存され replay でも同一IDで再現）
  name: string;
}

export const addLayerHandler: OpHandler = {
  type: 'addLayer',
  klass: 'edit',

  apply(state: EditorState, op: Operation): EditorState {
    const { layerId, name } = op.params as unknown as AddLayerParams;
    if (state.layers.some((l) => l.id === layerId)) return state; // 冪等
    const layer = createLayer(layerId, name, state.width, state.height);
    return {
      ...state,
      layers: [...state.layers, layer],
      activeLayerId: layerId,
    };
  },

  // レイヤ追加は統合しない。
};

export function createAddLayerOp(
  layerId: string,
  name: string,
  width: number,
  height: number,
): Operation {
  return {
    id: genId('addLayer'),
    type: 'addLayer',
    klass: 'edit',
    params: { layerId, name },
    region: fullCanvas(width, height),
    layerId, // 対象は新規レイヤ自身
    timestamp: Date.now(),
  };
}
