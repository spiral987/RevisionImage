import type { BBox, EditorState, Layer, LayerNode, Operation } from '../../types';
import type { OpHandler } from '../operation';
import {
  getLayer,
  getNode,
  replaceLayer,
  updateNode,
  removeNode,
  insertNode,
} from '../editorState';
import {
  isGroup,
  createGroup,
  collectLeafIds,
  collectNodeIds,
  firstLeafId,
} from '../layer';
import { createImageBuffer } from '../imageBuffer';
import { compositeLayer } from '../composite';
import { fullCanvas, unionBBox } from '../geom';
import { genId } from '../../util/id';

/**
 * レイヤー（およびフォルダ＝グループ）の構造/表示プロパティを変更する操作群（klass=edit）。
 * すべて log に記録され replay で決定的に再構築できる（不変条件 state === replay(log) を維持）。
 *
 * 表示切替/不透明度/リネーム/折りたたみは「絶対値セット」なので連続適用は last-wins と等価。
 * よって consolidate は後勝ち（最新 op の値・id は prev を維持）でビット同一になる。
 */

const EMPTY: BBox = { x: 0, y: 0, w: 0, h: 0 };

function lastWins(prev: Operation, next: Operation): Operation {
  return {
    ...prev,
    params: next.params,
    region: unionBBox(prev.region, next.region),
    timestamp: next.timestamp,
  };
}

const sameTarget = (prev: Operation, next: Operation) =>
  prev.layerId === next.layerId ? lastWins(prev, next) : null;

// ---- 表示/非表示（リーフ・グループ共通） ----------------------------------
export interface SetLayerVisibilityParams {
  layerId: string;
  visible: boolean;
}

export const setLayerVisibilityHandler: OpHandler = {
  type: 'setLayerVisibility',
  klass: 'edit',
  apply(state, op) {
    if (!getNode(state, op.layerId)) return state;
    const { visible } = op.params as unknown as SetLayerVisibilityParams;
    return updateNode(state, op.layerId, (n) => ({ ...n, visible }));
  },
  consolidate: sameTarget,
};

export function createSetLayerVisibilityOp(layerId: string, visible: boolean, region?: BBox): Operation {
  return {
    id: genId('setLayerVisibility'),
    type: 'setLayerVisibility',
    klass: 'edit',
    params: { layerId, visible },
    region: region ?? EMPTY,
    layerId,
    timestamp: Date.now(),
  };
}

// ---- 不透明度（リーフ・グループ共通） --------------------------------------
export interface SetLayerOpacityParams {
  layerId: string;
  opacity: number;
}

export const setLayerOpacityHandler: OpHandler = {
  type: 'setLayerOpacity',
  klass: 'edit',
  apply(state, op) {
    if (!getNode(state, op.layerId)) return state;
    const { opacity } = op.params as unknown as SetLayerOpacityParams;
    const clamped = Math.max(0, Math.min(1, opacity));
    return updateNode(state, op.layerId, (n) => ({ ...n, opacity: clamped }));
  },
  consolidate: sameTarget,
};

export function createSetLayerOpacityOp(layerId: string, opacity: number, region?: BBox): Operation {
  return {
    id: genId('setLayerOpacity'),
    type: 'setLayerOpacity',
    klass: 'edit',
    params: { layerId, opacity: Math.max(0, Math.min(1, opacity)) },
    region: region ?? EMPTY,
    layerId,
    timestamp: Date.now(),
  };
}

// ---- リネーム（リーフ・グループ共通） --------------------------------------
export interface RenameLayerParams {
  layerId: string;
  name: string;
}

export const renameLayerHandler: OpHandler = {
  type: 'renameLayer',
  klass: 'edit',
  apply(state, op) {
    if (!getNode(state, op.layerId)) return state;
    const { name } = op.params as unknown as RenameLayerParams;
    return updateNode(state, op.layerId, (n) => ({ ...n, name }));
  },
  consolidate: sameTarget,
};

export function createRenameLayerOp(layerId: string, name: string): Operation {
  return {
    id: genId('renameLayer'),
    type: 'renameLayer',
    klass: 'edit',
    params: { layerId, name },
    region: EMPTY,
    layerId,
    timestamp: Date.now(),
  };
}

// ---- 削除（リーフ or グループ＝子孫ごと） ----------------------------------
export interface RemoveLayerParams {
  layerId: string;
}

export const removeLayerHandler: OpHandler = {
  type: 'removeLayer',
  klass: 'edit',
  apply(state, op) {
    const { layerId } = op.params as unknown as RemoveLayerParams;
    const node = getNode(state, layerId);
    if (!node) return state;
    const removedLeaves = collectLeafIds(node);
    const totalLeaves = state.layers.flatMap(collectLeafIds).length;
    if (totalLeaves - removedLeaves.length < 1) return state; // 最低1リーフは残す
    const { tree } = removeNode(state.layers, layerId);
    let activeLayerId = state.activeLayerId;
    if (removedLeaves.includes(activeLayerId)) activeLayerId = firstLeafId(tree) ?? activeLayerId;
    return { ...state, layers: tree, activeLayerId };
  },
};

export function createRemoveLayerOp(layerId: string, region?: BBox): Operation {
  return {
    id: genId('removeLayer'),
    type: 'removeLayer',
    klass: 'edit',
    params: { layerId },
    region: region ?? EMPTY,
    layerId,
    timestamp: Date.now(),
  };
}

// ---- 並べ替え（最上位のみ。後方互換のため残す。新 UI は moveNode を使う） ----
export interface ReorderLayerParams {
  layerId: string;
  toIndex: number;
}

export const reorderLayerHandler: OpHandler = {
  type: 'reorderLayer',
  klass: 'edit',
  apply(state, op) {
    const { layerId, toIndex } = op.params as unknown as ReorderLayerParams;
    const from = state.layers.findIndex((l) => l.id === layerId);
    if (from < 0) return state;
    const to = Math.max(0, Math.min(state.layers.length - 1, toIndex));
    if (from === to) return state;
    const layers = [...state.layers];
    const [moved] = layers.splice(from, 1);
    layers.splice(to, 0, moved);
    return { ...state, layers };
  },
};

export function createReorderLayerOp(layerId: string, toIndex: number, region?: BBox): Operation {
  return {
    id: genId('reorderLayer'),
    type: 'reorderLayer',
    klass: 'edit',
    params: { layerId, toIndex },
    region: region ?? EMPTY,
    layerId,
    timestamp: Date.now(),
  };
}

// ---- ツリー内の移動（フォルダ出し入れ・並べ替えを一般化） -------------------
export interface MoveNodeParams {
  nodeId: string;
  parentId: string | null; // null = 最上位
  index: number;
}

export const moveNodeHandler: OpHandler = {
  type: 'moveNode',
  klass: 'edit',
  apply(state, op) {
    const { nodeId, parentId, index } = op.params as unknown as MoveNodeParams;
    const node = getNode(state, nodeId);
    if (!node) return state;
    if (parentId !== null) {
      const target = getNode(state, parentId);
      if (!target || !isGroup(target)) return state; // 親はグループのみ
      if (collectNodeIds(node).includes(parentId)) return state; // 自分の子孫へは不可（循環防止）
    }
    const { tree, removed } = removeNode(state.layers, nodeId);
    if (!removed) return state;
    return { ...state, layers: insertNode(tree, parentId, index, removed) };
  },
};

export function createMoveNodeOp(nodeId: string, parentId: string | null, index: number): Operation {
  return {
    id: genId('moveNode'),
    type: 'moveNode',
    klass: 'edit',
    params: { nodeId, parentId, index },
    region: EMPTY,
    layerId: nodeId,
    timestamp: Date.now(),
  };
}

// ---- フォルダ作成（空 / アクティブレイヤーを包む） -------------------------
export interface AddGroupParams {
  groupId: string;
  name: string;
  wrapLayerId?: string | null;
}

export const addGroupHandler: OpHandler = {
  type: 'addGroup',
  klass: 'edit',
  apply(state, op) {
    const { groupId, name, wrapLayerId } = op.params as unknown as AddGroupParams;
    if (getNode(state, groupId)) return state; // 冪等
    const group = createGroup(groupId, name);
    if (wrapLayerId) {
      if (!getNode(state, wrapLayerId)) return state;
      // wrapLayerId のノードを元の位置でグループに包む。
      const wrap = (nodes: LayerNode[]): LayerNode[] => {
        const i = nodes.findIndex((n) => n.id === wrapLayerId);
        if (i >= 0) {
          const out = [...nodes];
          out.splice(i, 1, { ...group, children: [nodes[i]] });
          return out;
        }
        return nodes.map((n) => (isGroup(n) ? { ...n, children: wrap(n.children) } : n));
      };
      return { ...state, layers: wrap(state.layers) };
    }
    return { ...state, layers: [...state.layers, group] };
  },
};

export function createAddGroupOp(groupId: string, name: string, wrapLayerId?: string | null): Operation {
  return {
    id: genId('addGroup'),
    type: 'addGroup',
    klass: 'edit',
    params: { groupId, name, wrapLayerId: wrapLayerId ?? null },
    region: EMPTY,
    layerId: groupId,
    timestamp: Date.now(),
  };
}

// ---- フォルダの折りたたみ（UI 状態だが replay 整合のため操作化） ------------
export interface SetGroupCollapsedParams {
  groupId: string;
  collapsed: boolean;
}

export const setGroupCollapsedHandler: OpHandler = {
  type: 'setGroupCollapsed',
  klass: 'edit',
  apply(state, op) {
    const { groupId, collapsed } = op.params as unknown as SetGroupCollapsedParams;
    const node = getNode(state, groupId);
    if (!node || !isGroup(node)) return state;
    return updateNode(state, groupId, (n) => ({ ...n, collapsed }));
  },
  consolidate: sameTarget,
};

export function createSetGroupCollapsedOp(groupId: string, collapsed: boolean): Operation {
  return {
    id: genId('setGroupCollapsed'),
    type: 'setGroupCollapsed',
    klass: 'edit',
    params: { groupId, collapsed },
    region: EMPTY,
    layerId: groupId,
    timestamp: Date.now(),
  };
}

// ---- 全消去（リーフ内容を透明に） -----------------------------------------
export interface ClearLayerParams {
  layerId: string;
}

export const clearLayerHandler: OpHandler = {
  type: 'clearLayer',
  klass: 'edit',
  apply(state, op) {
    const layer = getLayer(state, op.layerId);
    if (!layer) return state;
    const newLayer: Layer = {
      ...layer,
      buffer: createImageBuffer(state.width, state.height),
      offsetX: 0,
      offsetY: 0,
    };
    return replaceLayer(state, newLayer);
  },
};

export function createClearLayerOp(
  layerId: string,
  width: number,
  height: number,
  region?: BBox,
): Operation {
  return {
    id: genId('clearLayer'),
    type: 'clearLayer',
    klass: 'edit',
    params: { layerId },
    region: region ?? fullCanvas(width, height),
    layerId,
    timestamp: Date.now(),
  };
}

// ---- 下のレイヤーと統合（merge down。同じ親内の隣接リーフ同士のみ） ----------
export interface MergeDownLayerParams {
  layerId: string;
}

export const mergeDownLayerHandler: OpHandler = {
  type: 'mergeDownLayer',
  klass: 'edit',
  apply(state, op) {
    const { layerId } = op.params as unknown as MergeDownLayerParams;
    const w = state.width;
    const h = state.height;
    let activeLayerId = state.activeLayerId;

    const transform = (nodes: LayerNode[]): LayerNode[] => {
      const idx = nodes.findIndex((n) => n.id === layerId);
      if (idx > 0) {
        const upper = nodes[idx];
        const lower = nodes[idx - 1];
        if (!isGroup(upper) && !isGroup(lower)) {
          const buf = createImageBuffer(w, h);
          compositeLayer(buf, lower);
          compositeLayer(buf, upper);
          const merged: Layer = {
            id: lower.id,
            name: lower.name,
            buffer: buf,
            offsetX: 0,
            offsetY: 0,
            visible: true,
            opacity: 1,
          };
          if (activeLayerId === upper.id) activeLayerId = lower.id;
          const out = [...nodes];
          out.splice(idx - 1, 2, merged);
          return out;
        }
      }
      return nodes.map((n) => (isGroup(n) ? { ...n, children: transform(n.children) } : n));
    };

    const layers = transform(state.layers);
    return { ...state, layers, activeLayerId };
  },
};

export function createMergeDownLayerOp(layerId: string, region?: BBox): Operation {
  return {
    id: genId('mergeDownLayer'),
    type: 'mergeDownLayer',
    klass: 'edit',
    params: { layerId },
    region: region ?? EMPTY,
    layerId,
    timestamp: Date.now(),
  };
}
