import { describe, it, expect } from 'vitest';
import { EditorSession } from '../src/session';
import { BASE_LAYER_ID } from '../src/engine/editorState';
import { createBrushOp, createBrightnessOp } from '../src/engine/operations';
import { statesEqual, line } from './helpers';

const W = 64;
const H = 64;
const P = { color: [220, 30, 30] as [number, number, number], size: 8, opacity: 1 };

describe('EditorSession undo/redo', () => {
  it('1 ジェスチャ単位で戻り、不変条件 state === replay(log) を保つ', () => {
    const session = new EditorSession(W, H);
    expect(session.canUndo()).toBe(false);

    session.apply(createBrushOp(BASE_LAYER_ID, line(2, 2, 20, 20, 5), P, W, H));
    session.apply(createBrightnessOp(BASE_LAYER_ID, 40, W, H));
    expect(session.getLog().length).toBe(2);
    expect(session.canUndo()).toBe(true);

    const afterBrushState = (() => {
      const s = new EditorSession(W, H);
      s.apply(createBrushOp(BASE_LAYER_ID, line(2, 2, 20, 20, 5), P, W, H));
      return s.state;
    })();

    expect(session.undo()).toBe(true); // brightness を取り消す
    expect(session.getLog().length).toBe(1);
    expect(statesEqual(session.state, afterBrushState)).toBe(true);

    expect(session.undo()).toBe(true); // brush を取り消す → 空
    expect(session.getLog().length).toBe(0);
    expect(session.canUndo()).toBe(false);
    expect(session.canRedo()).toBe(true);

    expect(session.undo()).toBe(false); // これ以上戻れない
  });

  it('consolidate された連続ブラシでも 1 ストロークずつ戻る', () => {
    const session = new EditorSession(W, H);
    session.apply(createBrushOp(BASE_LAYER_ID, line(2, 2, 20, 2, 5), P, W, H));
    session.apply(createBrushOp(BASE_LAYER_ID, line(2, 30, 20, 30, 5), P, W, H));
    session.apply(createBrushOp(BASE_LAYER_ID, line(2, 50, 20, 50, 5), P, W, H));
    // 3 ストロークは 1 ログエントリに統合される。
    expect(session.getLog().length).toBe(1);

    // それでも undo は 3 回（ジェスチャ単位）でき、最後は空になる。
    expect(session.undo()).toBe(true);
    expect(session.undo()).toBe(true);
    expect(session.undo()).toBe(true);
    expect(session.getLog().length).toBe(0);
    expect(session.canUndo()).toBe(false);
  });

  it('redo は undo を巻き戻し、新しい編集で redo スタックは破棄される', () => {
    const session = new EditorSession(W, H);
    session.apply(createBrushOp(BASE_LAYER_ID, line(2, 2, 20, 20, 5), P, W, H));
    session.apply(createBrightnessOp(BASE_LAYER_ID, 30, W, H));
    const liveState = session.state;

    session.undo();
    expect(session.redo()).toBe(true);
    expect(statesEqual(session.state, liveState)).toBe(true);

    // undo 後に新規編集すると redo は無効化される。
    session.undo();
    session.apply(createBrightnessOp(BASE_LAYER_ID, -10, W, H));
    expect(session.canRedo()).toBe(false);
  });
});
