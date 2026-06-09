import type { EditorState, Layer } from '../types';
import { createLayer } from './layer';

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

export function getLayer(state: EditorState, id: string): Layer | undefined {
  return state.layers.find((l) => l.id === id);
}

/** 指定レイヤを置き換えた新しい状態を返す（イミュータブル）。 */
export function replaceLayer(state: EditorState, layer: Layer): EditorState {
  return {
    ...state,
    layers: state.layers.map((l) => (l.id === layer.id ? layer : l)),
  };
}
