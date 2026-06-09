import { describe, it, expect } from 'vitest';
import { EditorSession } from '../src/session';
import { BASE_LAYER_ID, createInitialState } from '../src/engine/editorState';
import { applyOperation } from '../src/engine/operation';
import {
  createAddLayerOp,
  createSetLayerVisibilityOp,
  createSetLayerOpacityOp,
  createRenameLayerOp,
  createRemoveLayerOp,
  createReorderLayerOp,
} from '../src/engine/operations';
import { statesEqual } from './helpers';

const W = 32;
const H = 32;

function replay(session: EditorSession) {
  let s = createInitialState(W, H);
  for (const op of session.getLog()) s = applyOperation(s, op);
  return s;
}

describe('レイヤー操作', () => {
  it('visibility/opacity/rename を適用でき、不変条件を保つ', () => {
    const s = new EditorSession(W, H);
    s.apply(createSetLayerVisibilityOp(BASE_LAYER_ID, false));
    s.apply(createSetLayerOpacityOp(BASE_LAYER_ID, 0.5));
    s.apply(createRenameLayerOp(BASE_LAYER_ID, 'BG'));
    const base = s.state.layers[0];
    expect(base.visible).toBe(false);
    expect(base.opacity).toBeCloseTo(0.5);
    expect(base.name).toBe('BG');
    expect(statesEqual(s.state, replay(s))).toBe(true);
  });

  it('連続 opacity 変更は last-wins で1エントリに統合される', () => {
    const s = new EditorSession(W, H);
    s.apply(createSetLayerOpacityOp(BASE_LAYER_ID, 0.8));
    s.apply(createSetLayerOpacityOp(BASE_LAYER_ID, 0.6));
    s.apply(createSetLayerOpacityOp(BASE_LAYER_ID, 0.4));
    expect(s.getLog().length).toBe(1);
    expect(s.state.layers[0].opacity).toBeCloseTo(0.4);
    expect(statesEqual(s.state, replay(s))).toBe(true);
  });

  it('削除は最低1レイヤを残し、active を付け替える', () => {
    const s = new EditorSession(W, H);
    s.apply(createAddLayerOp('L1', 'L1', W, H)); // active=L1
    expect(s.state.activeLayerId).toBe('L1');
    s.apply(createRemoveLayerOp('L1'));
    expect(s.state.layers.length).toBe(1);
    expect(s.state.activeLayerId).toBe(BASE_LAYER_ID);
    // 最後の1枚は削除されない。
    s.apply(createRemoveLayerOp(BASE_LAYER_ID));
    expect(s.state.layers.length).toBe(1);
    expect(statesEqual(s.state, replay(s))).toBe(true);
  });

  it('並べ替えで合成順（layers 配列順）が変わる', () => {
    const s = new EditorSession(W, H);
    s.apply(createAddLayerOp('L1', 'L1', W, H));
    s.apply(createAddLayerOp('L2', 'L2', W, H));
    // 並び: [base, L1, L2]
    expect(s.state.layers.map((l) => l.id)).toEqual([BASE_LAYER_ID, 'L1', 'L2']);
    s.apply(createReorderLayerOp('L2', 0)); // L2 を最背面へ
    expect(s.state.layers.map((l) => l.id)).toEqual(['L2', BASE_LAYER_ID, 'L1']);
    expect(statesEqual(s.state, replay(s))).toBe(true);
  });
});
