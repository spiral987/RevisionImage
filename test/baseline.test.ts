import { describe, it, expect } from 'vitest';
import { EditorSession } from '../src/session';
import { applyOperation } from '../src/engine/operation';
import { createInitialState, BASE_LAYER_ID } from '../src/engine/editorState';
import {
  createBrushOp,
  createAddLayerOp,
  createSetLayerOpacityOp,
  createSetLayerVisibilityOp,
  createAddGroupOp,
  createMoveNodeOp,
} from '../src/engine/operations';
import { statesEqual, line } from './helpers';

const W = 48;
const H = 48;
const P = { color: [200, 40, 40] as [number, number, number], size: 8, opacity: 1 };

/** ログを初期状態から再適用する（不変条件 state === replay(log) の検証用）。 */
function replay(log: readonly ReturnType<typeof createBrushOp>[]) {
  let s = createInitialState(W, H);
  for (const op of log) s = applyOperation(s, op);
  return s;
}

describe('flattenToBaseline（履歴を畳む / 絵は残す）', () => {
  it('グループ・不透明度・非表示を含む見た目を保ったまま log を1件に畳む', () => {
    const session = new EditorSession(W, H);
    // 背景に描画 → 新レイヤ追加 → そこへ描画 → 不透明度/非表示/フォルダ収納まで作る
    session.apply(createBrushOp(BASE_LAYER_ID, line(3, 3, 40, 40, 6), P, W, H));
    session.apply(createAddLayerOp('layer-2', 'Layer 1', W, H));
    session.apply(createBrushOp('layer-2', line(40, 3, 3, 40, 6), { ...P, color: [30, 60, 200] }, W, H));
    session.apply(createSetLayerOpacityOp('layer-2', 0.4));
    session.apply(createAddGroupOp('grp-1', 'Folder', 'layer-2')); // layer-2 を包む
    session.apply(createSetLayerVisibilityOp('grp-1', false)); // グループごと非表示

    const before = session.state;
    expect(session.getLog().length).toBeGreaterThan(1);

    session.flattenToBaseline();

    // log は baseline 1件に畳まれる
    const log = session.getLog();
    expect(log.length).toBe(1);
    expect(log[0].type).toBe('baseline');

    // 見た目（ツリー全体：グループ/不透明度/非表示/オフセット/画素）は不変
    expect(statesEqual(session.state, before)).toBe(true);

    // 不変条件: 初期状態から log を replay すると現在状態に一致する
    expect(statesEqual(replay(log as never), session.state)).toBe(true);
  });

  it('revisions / undo を捨てる', () => {
    const session = new EditorSession(W, H);
    session.apply(createBrushOp(BASE_LAYER_ID, line(2, 2, 20, 20, 4), P, W, H));
    session.commitRevision('rev A');
    session.apply(createBrushOp(BASE_LAYER_ID, line(20, 2, 2, 20, 4), P, W, H));
    expect(session.canUndo()).toBe(true);
    expect(session.revisions.length).toBeGreaterThan(0);

    session.flattenToBaseline();

    expect(session.revisions.length).toBe(0);
    expect(session.canUndo()).toBe(false);
    expect(session.canRedo()).toBe(false);
  });

  it('畳んだあと再度編集でき、不変条件を保つ', () => {
    const session = new EditorSession(W, H);
    session.apply(createBrushOp(BASE_LAYER_ID, line(3, 3, 30, 30, 5), P, W, H));
    session.flattenToBaseline();
    // baseline の上にさらにブラシ
    session.apply(createBrushOp(BASE_LAYER_ID, line(30, 3, 3, 30, 5), { ...P, color: [40, 200, 60] }, W, H));

    const log = session.getLog();
    expect(log.length).toBe(2); // baseline + brush
    expect(statesEqual(replay(log as never), session.state)).toBe(true);
  });
});
