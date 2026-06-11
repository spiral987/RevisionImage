import { describe, it, expect } from 'vitest';
import { EditorSession } from '../src/session';
import { BASE_LAYER_ID, createInitialState, getNode } from '../src/engine/editorState';
import { applyOperation } from '../src/engine/operation';
import { isGroup } from '../src/engine/layer';
import { flattenState } from '../src/engine/composite';
import {
  createAddLayerOp,
  createAddGroupOp,
  createMoveNodeOp,
  createSetLayerVisibilityOp,
  createSetGroupCollapsedOp,
  createBrushOp,
  createRemoveLayerOp,
} from '../src/engine/operations';
import { line, statesEqual } from './helpers';

const W = 16;
const H = 16;

function replay(s: EditorSession) {
  let st = createInitialState(s.width, s.height);
  for (const op of s.getLog()) st = applyOperation(st, op);
  return st;
}

describe('レイヤーフォルダ（グループ）', () => {
  it('空フォルダを追加でき、replay 不変条件を保つ', () => {
    const s = new EditorSession(W, H);
    s.apply(createAddGroupOp('g1', 'Folder'));
    expect(s.state.layers.map((n) => n.id)).toEqual([BASE_LAYER_ID, 'g1']);
    expect(isGroup(getNode(s.state, 'g1')!)).toBe(true);
    expect(statesEqual(s.state, replay(s))).toBe(true);
  });

  it('アクティブレイヤーをその場でフォルダに包める', () => {
    const s = new EditorSession(W, H);
    s.apply(createAddLayerOp('L1', 'L1', W, H));
    s.apply(createAddGroupOp('g1', 'Folder', 'L1'));
    expect(s.state.layers.map((n) => n.id)).toEqual([BASE_LAYER_ID, 'g1']);
    const g = getNode(s.state, 'g1')!;
    expect(isGroup(g) && g.children.map((c) => c.id)).toEqual(['L1']);
    expect(statesEqual(s.state, replay(s))).toBe(true);
  });

  it('moveNode でフォルダに出し入れできる', () => {
    const s = new EditorSession(W, H);
    s.apply(createAddGroupOp('g1', 'Folder'));
    s.apply(createAddLayerOp('L1', 'L1', W, H));
    s.apply(createMoveNodeOp('L1', 'g1', 0)); // 中へ
    const g = getNode(s.state, 'g1')!;
    expect(isGroup(g) && g.children.map((c) => c.id)).toEqual(['L1']);
    expect(s.state.layers.map((n) => n.id)).toEqual([BASE_LAYER_ID, 'g1']);

    s.apply(createMoveNodeOp('L1', null, 99)); // 外へ（末尾にクランプ）
    const g2 = getNode(s.state, 'g1')!;
    expect(isGroup(g2) && g2.children.length).toBe(0);
    expect(s.state.layers.map((n) => n.id)).toEqual([BASE_LAYER_ID, 'g1', 'L1']);
    expect(statesEqual(s.state, replay(s))).toBe(true);
  });

  it('グループを自身の子孫へは移動できない（循環防止）', () => {
    const s = new EditorSession(W, H);
    s.apply(createAddGroupOp('outer', 'Outer'));
    s.apply(createAddGroupOp('inner', 'Inner'));
    s.apply(createMoveNodeOp('inner', 'outer', 0));
    s.apply(createMoveNodeOp('outer', 'inner', 0)); // outer を子孫 inner へ → 無視
    expect(s.state.layers.some((n) => n.id === 'outer')).toBe(true);
    expect(statesEqual(s.state, replay(s))).toBe(true);
  });

  it('フォルダの表示OFFで中身が合成されない', () => {
    const s = new EditorSession(W, H);
    s.apply(createAddLayerOp('L1', 'L1', W, H));
    s.apply(createBrushOp('L1', line(0, 0, W, H, W), { color: [255, 0, 0], size: 24, opacity: 1 }, W, H));
    s.apply(createAddGroupOp('g1', 'Folder', 'L1'));
    s.apply(createSetLayerVisibilityOp('g1', false));
    const flat = flattenState(s.state);
    const ci = (8 * W + 8) * 4;
    expect([flat.data[ci], flat.data[ci + 1], flat.data[ci + 2]]).toEqual([255, 255, 255]); // 白背景
    expect(statesEqual(s.state, replay(s))).toBe(true);
  });

  it('フォルダ削除で子ごと消え、active が付け替わる', () => {
    const s = new EditorSession(W, H);
    s.apply(createAddLayerOp('L1', 'L1', W, H)); // active=L1
    s.apply(createAddGroupOp('g1', 'Folder', 'L1'));
    expect(s.state.activeLayerId).toBe('L1');
    s.apply(createRemoveLayerOp('g1'));
    expect(getNode(s.state, 'g1')).toBeUndefined();
    expect(getNode(s.state, 'L1')).toBeUndefined();
    expect(s.state.activeLayerId).toBe(BASE_LAYER_ID);
    expect(statesEqual(s.state, replay(s))).toBe(true);
  });

  it('折りたたみ操作が replay 整合する', () => {
    const s = new EditorSession(W, H);
    s.apply(createAddGroupOp('g1', 'Folder'));
    s.apply(createSetGroupCollapsedOp('g1', true));
    const g = getNode(s.state, 'g1')!;
    expect(isGroup(g) && g.collapsed).toBe(true);
    expect(statesEqual(s.state, replay(s))).toBe(true);
  });
});
