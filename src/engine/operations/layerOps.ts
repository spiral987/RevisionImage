import type { BBox, EditorState, Operation } from '../../types';
import type { OpHandler } from '../operation';
import { getLayer, replaceLayer } from '../editorState';
import { cloneLayer } from '../layer';
import { unionBBox } from '../geom';
import { genId } from '../../util/id';

/**
 * レイヤーの構造/表示プロパティを変更する操作群（klass=edit）。すべて log に記録され
 * replay で決定的に再構築できる（不変条件 state === replay(log) を維持）。
 *
 * 表示切替/不透明度/リネームは「絶対値セット」なので、連続適用は last-wins と等価。
 * したがって consolidate は後勝ち（最新 op の値を採用、id は prev を維持して DAG ノード
 * 同一性を保つ）でビット同一になり、スライダー連続操作などでもログが肥大化しない。
 */

const EMPTY: BBox = { x: 0, y: 0, w: 0, h: 0 };

/** 後勝ち統合: prev の id を保ちつつ最新の params/region に置き換える。 */
function lastWins(prev: Operation, next: Operation): Operation {
  return {
    ...prev,
    params: next.params,
    region: unionBBox(prev.region, next.region),
    timestamp: next.timestamp,
  };
}

// ---- 表示/非表示 ----------------------------------------------------------
export interface SetLayerVisibilityParams {
  layerId: string;
  visible: boolean;
}

export const setLayerVisibilityHandler: OpHandler = {
  type: 'setLayerVisibility',
  klass: 'edit',
  apply(state, op) {
    const layer = getLayer(state, op.layerId);
    if (!layer) return state;
    const { visible } = op.params as unknown as SetLayerVisibilityParams;
    const newLayer = cloneLayer(layer, { cloneBuffer: false });
    newLayer.visible = visible;
    return replaceLayer(state, newLayer);
  },
  consolidate: (prev, next) => (prev.layerId === next.layerId ? lastWins(prev, next) : null),
};

export function createSetLayerVisibilityOp(
  layerId: string,
  visible: boolean,
  region?: BBox,
): Operation {
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

// ---- 不透明度 -------------------------------------------------------------
export interface SetLayerOpacityParams {
  layerId: string;
  opacity: number;
}

export const setLayerOpacityHandler: OpHandler = {
  type: 'setLayerOpacity',
  klass: 'edit',
  apply(state, op) {
    const layer = getLayer(state, op.layerId);
    if (!layer) return state;
    const { opacity } = op.params as unknown as SetLayerOpacityParams;
    const newLayer = cloneLayer(layer, { cloneBuffer: false });
    newLayer.opacity = Math.max(0, Math.min(1, opacity));
    return replaceLayer(state, newLayer);
  },
  consolidate: (prev, next) => (prev.layerId === next.layerId ? lastWins(prev, next) : null),
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

// ---- リネーム -------------------------------------------------------------
export interface RenameLayerParams {
  layerId: string;
  name: string;
}

export const renameLayerHandler: OpHandler = {
  type: 'renameLayer',
  klass: 'edit',
  apply(state, op) {
    const layer = getLayer(state, op.layerId);
    if (!layer) return state;
    const { name } = op.params as unknown as RenameLayerParams;
    const newLayer = cloneLayer(layer, { cloneBuffer: false });
    newLayer.name = name;
    return replaceLayer(state, newLayer);
  },
  consolidate: (prev, next) => (prev.layerId === next.layerId ? lastWins(prev, next) : null),
};

export function createRenameLayerOp(layerId: string, name: string): Operation {
  return {
    id: genId('renameLayer'),
    type: 'renameLayer',
    klass: 'edit',
    params: { layerId, name },
    region: EMPTY, // 見た目の画素は変わらないので空（依存判定で独立）
    layerId,
    timestamp: Date.now(),
  };
}

// ---- 削除 -----------------------------------------------------------------
export interface RemoveLayerParams {
  layerId: string;
}

export const removeLayerHandler: OpHandler = {
  type: 'removeLayer',
  klass: 'edit',
  apply(state, op) {
    const { layerId } = op.params as unknown as RemoveLayerParams;
    if (state.layers.length <= 1) return state; // 最低 1 レイヤは残す
    if (!state.layers.some((l) => l.id === layerId)) return state;
    const layers = state.layers.filter((l) => l.id !== layerId);
    const activeLayerId =
      state.activeLayerId === layerId ? layers[layers.length - 1].id : state.activeLayerId;
    return { ...state, layers, activeLayerId };
  },
  // 削除は統合しない。
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

// ---- 並べ替え -------------------------------------------------------------
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
  // 並べ替えは統合しない。
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
