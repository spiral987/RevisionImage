import { describe, it, expect } from 'vitest';
import '../src/engine/operations';
import { EditorSession } from '../src/session';
import { createBrushOp } from '../src/engine/operations';
import { createInitialState, BASE_LAYER_ID } from '../src/engine/editorState';
import { applyOperation } from '../src/engine/operation';
import { ROOT_ID } from '../src/backend/dag';
import { statesEqual, line } from './helpers';

const W = 64;
const H = 64;
const P = { color: [200, 30, 30] as [number, number, number], size: 4, opacity: 1 };
// 1点ブラシ。領域(region)が近ければ重なり=依存、遠ければ独立。
const dot = (x: number, y: number) => createBrushOp(BASE_LAYER_ID, line(x, y, x, y, 1), P, W, H);

/** 初期状態から getLog() を replay した state（不変条件 state === replay(log) の検査用）。 */
function replay(s: EditorSession) {
  let st = createInitialState(s.width, s.height);
  for (const op of s.getLog()) st = applyOperation(st, op);
  return st;
}

// consolidate を避けて厳密なログを作るため checkout(setLog) で組む。
function sessionWith(...ops: ReturnType<typeof dot>[]) {
  const s = new EditorSession(W, H);
  s.checkout(ops);
  return s;
}

describe('selective undo（原論文: 過去操作を無かったことにする）', () => {
  it('指定操作とその依存（後続）を除去し、独立な操作は残す', () => {
    const a = dot(10, 10);
    const b = dot(11, 11); // a と重なる → a に依存
    const indep = dot(55, 55); // 独立
    const s = sessionWith(a, b, indep);

    expect([...s.selectiveUndoTargets(a.id)].sort()).toEqual([a.id, b.id].sort());

    expect(s.selectiveUndo(a.id)).toBe(true);
    expect(s.getLog().map((o) => o.id)).toEqual([indep.id]); // a, b は消え indep は残る
    expect(statesEqual(s.state, replay(s))).toBe(true); // 不変条件を保つ
  });

  it('途中の独立操作は残り、依存する後続だけ消える（selective の核心）', () => {
    const a = dot(10, 10);
    const mid = dot(55, 55); // a と独立（間に挟まる）
    const dep = dot(11, 11); // a に依存
    const s = sessionWith(a, mid, dep);

    expect([...s.selectiveUndoTargets(a.id)].sort()).toEqual([a.id, dep.id].sort());
    expect(s.selectiveUndo(a.id)).toBe(true);
    expect(s.getLog().map((o) => o.id)).toEqual([mid.id]); // 間の独立操作だけ残る
  });

  it('依存される側を持たない操作は単独で消える', () => {
    const a = dot(10, 10);
    const b = dot(55, 55); // 独立
    const s = sessionWith(a, b);

    expect([...s.selectiveUndoTargets(b.id)]).toEqual([b.id]); // b に依存する後続なし
    s.selectiveUndo(b.id);
    expect(s.getLog().map((o) => o.id)).toEqual([a.id]);
  });

  it('複数 id をまとめて selective undo（依存の和集合）', () => {
    const a = dot(10, 10);
    const b = dot(11, 11); // a に依存
    const c = dot(55, 55); // 独立
    const s = sessionWith(a, b, c);

    expect([...s.selectiveUndoTargets([a.id, c.id])].sort()).toEqual([a.id, b.id, c.id].sort());
    s.selectiveUndo([a.id, c.id]);
    expect(s.getLog().length).toBe(0);
  });

  it('1 回の Undo で元に戻る（checkout と違い履歴を消さない）', () => {
    const a = dot(10, 10);
    const b = dot(11, 11);
    const c = dot(55, 55);
    const s = sessionWith(a, b, c);
    const before = s.getLog().map((o) => o.id);

    s.selectiveUndo(a.id);
    expect(s.getLog().map((o) => o.id)).toEqual([c.id]);

    expect(s.undo()).toBe(true);
    expect(s.getLog().map((o) => o.id)).toEqual(before);
    expect(statesEqual(s.state, replay(s))).toBe(true);
  });

  it('非破壊（NRCI）: 取り消し前にコミットすれば外した操作はリビジョンに残り完全復元できる', () => {
    const a = dot(10, 10);
    const b = dot(11, 11); // a に依存
    const c = dot(55, 55);
    const s = sessionWith(a, b, c);

    // App.doSelectiveUndo の autoCheckpointIfDirty 相当（取り消し前状態を永続化）。
    const rev = s.commitRevision('before undo');
    s.selectiveUndo(a.id);

    // 作業ログからは外れるが…
    expect(s.getLog().map((o) => o.id)).toEqual([c.id]);
    // 取り消した操作はリビジョン（永続）に残っており、恒久的には失われない。
    expect(rev.ops.map((o) => o.id)).toEqual([a.id, b.id, c.id]);
    // checkout/branch でその版へ戻れば完全復元できる。
    s.checkout(rev.ops);
    expect(s.getLog().map((o) => o.id)).toEqual([a.id, b.id, c.id]);
    expect(statesEqual(s.state, replay(s))).toBe(true);
  });

  it('selectiveUndo はコミット済みリビジョンを書き換えない（作業ログのみ操作）', () => {
    const a = dot(10, 10);
    const b = dot(11, 11);
    const s = sessionWith(a, b);
    const rev = s.commitRevision('snap');
    const before = rev.ops.map((o) => o.id);
    s.selectiveUndo(a.id);
    expect(rev.ops.map((o) => o.id)).toEqual(before); // リビジョンは不変
  });

  it('root / 作業ログに無い id は no-op', () => {
    const a = dot(10, 10);
    const s = sessionWith(a);
    expect(s.selectiveUndo(ROOT_ID)).toBe(false);
    expect(s.selectiveUndo('no-such-op')).toBe(false);
    expect(s.selectiveUndoTargets('no-such-op').size).toBe(0);
    expect(s.getLog().map((o) => o.id)).toEqual([a.id]); // 不変
  });
});
