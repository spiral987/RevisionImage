import type { EditorState, Layer, LayerGroup, LayerNode, Operation } from '../../types';
import type { OpHandler } from '../operation';
import { base64ToBuffer, bufferToBase64 } from '../imageBuffer';
import { isGroup } from '../layer';
import { fullCanvas } from '../geom';
import { genId } from '../../util/id';

/**
 * 履歴の畳み込み（"baseline" / flatten history）操作（klass=edit）。
 * 現在のレイヤーツリー全体（グループ入れ子・不透明度・表示/非表示・オフセット・名前・画素）を
 * base64(RGBA) として op 内に保持し、apply で state を丸ごと差し替える。
 *
 * これ1つを replay すると元の見た目を完全に再構築できるので、log を本 op 1件に畳んでも
 * 不変条件 state === replay(log) と save/load（log を初期状態から replay）を保てる。
 * 「絵は残し履歴だけ消す」Reset の実体。region は全面で addLayer 同様の全面チェックポイント。
 */

interface SerializedLayer {
  kind: 'layer';
  id: string;
  name: string;
  offsetX: number;
  offsetY: number;
  visible: boolean;
  opacity: number;
  imgWidth: number;
  imgHeight: number;
  data: string; // base64 RGBA, 長さ = imgWidth*imgHeight*4
}
interface SerializedGroup {
  kind: 'group';
  id: string;
  name: string;
  visible: boolean;
  opacity: number;
  collapsed: boolean;
  children: SerializedNode[];
}
type SerializedNode = SerializedLayer | SerializedGroup;

export interface BaselineParams {
  tree: SerializedNode[];
  activeLayerId: string;
}

function serializeNode(n: LayerNode): SerializedNode {
  if (isGroup(n)) {
    return {
      kind: 'group',
      id: n.id,
      name: n.name,
      visible: n.visible,
      opacity: n.opacity,
      collapsed: n.collapsed,
      children: n.children.map(serializeNode),
    };
  }
  return {
    kind: 'layer',
    id: n.id,
    name: n.name,
    offsetX: n.offsetX,
    offsetY: n.offsetY,
    visible: n.visible,
    opacity: n.opacity,
    imgWidth: n.buffer.width,
    imgHeight: n.buffer.height,
    data: bufferToBase64(n.buffer),
  };
}

function deserializeNode(s: SerializedNode): LayerNode {
  if (s.kind === 'group') {
    const g: LayerGroup = {
      id: s.id,
      name: s.name,
      visible: s.visible,
      opacity: s.opacity,
      collapsed: s.collapsed,
      children: s.children.map(deserializeNode),
    };
    return g;
  }
  const layer: Layer = {
    id: s.id,
    name: s.name,
    buffer: base64ToBuffer(s.data, s.imgWidth, s.imgHeight),
    offsetX: s.offsetX,
    offsetY: s.offsetY,
    visible: s.visible,
    opacity: s.opacity,
  };
  return layer;
}

export const baselineHandler: OpHandler = {
  type: 'baseline',
  klass: 'edit',

  apply(state: EditorState, op: Operation): EditorState {
    const p = op.params as unknown as BaselineParams;
    return {
      ...state,
      layers: p.tree.map(deserializeNode),
      activeLayerId: p.activeLayerId,
    };
  },

  // 畳み込みは統合しない（その場の全状態スナップショット）。
};

/** 現在の state 全体を1つの baseline op にシリアライズする。 */
export function createBaselineOp(state: EditorState, canvasW: number, canvasH: number): Operation {
  const params: BaselineParams = {
    tree: state.layers.map(serializeNode),
    activeLayerId: state.activeLayerId,
  };
  return {
    id: genId('baseline'),
    type: 'baseline',
    klass: 'edit',
    params: params as unknown as Record<string, unknown>,
    region: fullCanvas(canvasW, canvasH),
    layerId: state.activeLayerId,
    timestamp: Date.now(),
  };
}
