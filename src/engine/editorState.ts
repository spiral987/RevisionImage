import type { EditorState, Layer, LayerNode } from '../types';
import { createLayer, isGroup } from './layer';

/** ルート状態のベースレイヤID。replay 時も同じIDで再構築されるよう固定する。 */
export const BASE_LAYER_ID = 'layer-base';

/**
 * ルート（初期化）状態を決定的に生成する。
 * Replayer はこの状態から log を順に applyOperation して状態を再構築する（SPEC §6）。
 */
export function createInitialState(width: number, height: number): EditorState {
  const base = createLayer(BASE_LAYER_ID, 'Background', width, height);
  return { width, height, layers: [base], activeLayerId: base.id };
}

// ---- ツリー走査ユーティリティ（レイヤーフォルダ導入で階層化） ----------------

/** id に一致するリーフ(Layer)を木から探す。描画系操作はこれでレイヤーを得る。 */
export function getLayer(state: EditorState, id: string): Layer | undefined {
  const find = (nodes: LayerNode[]): Layer | undefined => {
    for (const n of nodes) {
      if (isGroup(n)) {
        const r = find(n.children);
        if (r) return r;
      } else if (n.id === id) {
        return n;
      }
    }
    return undefined;
  };
  return find(state.layers);
}

/** ノードの親情報（親id=null は最上位、兄弟配列、その中での index）を返す。 */
export function getParentInfo(
  state: EditorState,
  id: string,
): { parentId: string | null; siblings: LayerNode[]; index: number } | null {
  const search = (
    nodes: LayerNode[],
    parentId: string | null,
  ): { parentId: string | null; siblings: LayerNode[]; index: number } | null => {
    const index = nodes.findIndex((n) => n.id === id);
    if (index >= 0) return { parentId, siblings: nodes, index };
    for (const n of nodes) {
      if (isGroup(n)) {
        const r = search(n.children, n.id);
        if (r) return r;
      }
    }
    return null;
  };
  return search(state.layers, null);
}

/** id に一致する任意のノード（リーフ or グループ）を探す。 */
export function getNode(state: EditorState, id: string): LayerNode | undefined {
  let found: LayerNode | undefined;
  const walk = (nodes: LayerNode[]) => {
    for (const n of nodes) {
      if (n.id === id) {
        found = n;
        return;
      }
      if (isGroup(n)) walk(n.children);
    }
  };
  walk(state.layers);
  return found;
}

/** 木の中の id 一致ノードに fn を適用して置き換えた新しい木を返す（イミュータブル）。 */
function mapNode(nodes: LayerNode[], id: string, fn: (n: LayerNode) => LayerNode): LayerNode[] {
  return nodes.map((n) => {
    if (n.id === id) return fn(n);
    if (isGroup(n)) return { ...n, children: mapNode(n.children, id, fn) };
    return n;
  });
}

/** 指定リーフを置き換えた新しい state を返す（描画系操作が使用）。 */
export function replaceLayer(state: EditorState, layer: Layer): EditorState {
  return { ...state, layers: mapNode(state.layers, layer.id, () => layer) };
}

/** 任意ノード（リーフ/グループ）を更新した新しい state を返す。 */
export function updateNode(
  state: EditorState,
  id: string,
  fn: (n: LayerNode) => LayerNode,
): EditorState {
  return { ...state, layers: mapNode(state.layers, id, fn) };
}

/** 木から id のノード（とその子孫）を取り除く。取り除いたノードも返す。 */
export function removeNode(
  nodes: LayerNode[],
  id: string,
): { tree: LayerNode[]; removed: LayerNode | null } {
  let removed: LayerNode | null = null;
  const walk = (ns: LayerNode[]): LayerNode[] => {
    const out: LayerNode[] = [];
    for (const n of ns) {
      if (n.id === id) {
        removed = n;
        continue;
      }
      out.push(isGroup(n) ? { ...n, children: walk(n.children) } : n);
    }
    return out;
  };
  const tree = walk(nodes);
  return { tree, removed };
}

/**
 * node を parentId（null=最上位）の index 位置に挿入した新しい木を返す。
 * index が範囲外なら末尾に丸める。
 */
export function insertNode(
  nodes: LayerNode[],
  parentId: string | null,
  index: number,
  node: LayerNode,
): LayerNode[] {
  if (parentId === null) {
    const i = Math.max(0, Math.min(nodes.length, index));
    const out = [...nodes];
    out.splice(i, 0, node);
    return out;
  }
  return nodes.map((n) => {
    if (n.id === parentId && isGroup(n)) {
      const i = Math.max(0, Math.min(n.children.length, index));
      const children = [...n.children];
      children.splice(i, 0, node);
      return { ...n, children };
    }
    if (isGroup(n)) return { ...n, children: insertNode(n.children, parentId, index, node) };
    return n;
  });
}
