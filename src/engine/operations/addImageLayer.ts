import type { EditorState, Layer, ImageBuffer, Operation } from '../../types';
import type { OpHandler } from '../operation';
import { base64ToBuffer, bufferToBase64 } from '../imageBuffer';
import { clampBBox } from '../geom';
import { genId } from '../../util/id';

/**
 * 画像を新規レイヤとして配置する操作（klass=edit）。
 * 画素は base64(RGBA) として op 内に保持されるため、log だけから決定的に replay できる
 * （不変条件 state === replay(log) を維持）。レイヤは buffer(画像サイズ) + offset(配置位置)。
 */
export interface AddImageLayerParams {
  layerId: string;
  name: string;
  imgWidth: number;
  imgHeight: number;
  offsetX: number;
  offsetY: number;
  data: string; // base64 RGBA, 長さ = imgWidth*imgHeight*4
}

export const addImageLayerHandler: OpHandler = {
  type: 'addImageLayer',
  klass: 'edit',

  apply(state: EditorState, op: Operation): EditorState {
    const p = op.params as unknown as AddImageLayerParams;
    if (state.layers.some((l) => l.id === p.layerId)) return state; // 冪等
    const buffer = base64ToBuffer(p.data, p.imgWidth, p.imgHeight);
    const layer: Layer = {
      id: p.layerId,
      name: p.name,
      buffer,
      offsetX: p.offsetX,
      offsetY: p.offsetY,
      visible: true,
      opacity: 1,
    };
    return {
      ...state,
      layers: [...state.layers, layer],
      activeLayerId: p.layerId,
    };
  },

  // 画像配置は統合しない。
};

export function createAddImageLayerOp(
  layerId: string,
  name: string,
  buffer: ImageBuffer,
  offsetX: number,
  offsetY: number,
  canvasW: number,
  canvasH: number,
): Operation {
  return {
    id: genId('addImageLayer'),
    type: 'addImageLayer',
    klass: 'edit',
    params: {
      layerId,
      name,
      imgWidth: buffer.width,
      imgHeight: buffer.height,
      offsetX,
      offsetY,
      data: bufferToBase64(buffer),
    },
    region: clampBBox(
      { x: offsetX, y: offsetY, w: buffer.width, h: buffer.height },
      canvasW,
      canvasH,
    ),
    layerId,
    timestamp: Date.now(),
  };
}
