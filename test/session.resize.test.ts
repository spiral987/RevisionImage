import { describe, it, expect } from 'vitest';
import { EditorSession } from '../src/session';
import { BASE_LAYER_ID, createInitialState } from '../src/engine/editorState';
import { applyOperation } from '../src/engine/operation';
import { createBrushOp } from '../src/engine/operations';
import { flattenState } from '../src/engine/composite';
import { line, statesEqual } from './helpers';

const P = { color: [200, 30, 30] as [number, number, number], size: 6, opacity: 1 };

function replayAt(session: EditorSession) {
  let s = createInitialState(session.width, session.height);
  for (const op of session.getLog()) s = applyOperation(s, op);
  return s;
}

describe('EditorSession.resize', () => {
  it('内容を絶対座標で保ち、新サイズで不変条件を満たす', () => {
    const session = new EditorSession(32, 32);
    session.apply(createBrushOp(BASE_LAYER_ID, line(8, 8, 24, 24, 8), P, 32, 32));

    const px = (s: ReturnType<typeof flattenState>, x: number, y: number) => {
      const i = (y * s.width + x) * 4;
      return [s.data[i], s.data[i + 1], s.data[i + 2]];
    };
    const before = px(flattenState(session.state), 16, 16); // 線の中央付近 = 赤寄り

    session.resize(64, 48);
    expect(session.width).toBe(64);
    expect(session.height).toBe(48);
    expect(session.state.width).toBe(64);

    // 同じ絶対座標 (16,16) の色が保たれている（左上基準のリサイズ）。
    expect(px(flattenState(session.state), 16, 16)).toEqual(before);
    // 新サイズで state === replay(log)。
    expect(statesEqual(session.state, replayAt(session))).toBe(true);
  });

  it('縮小しても拡大で内容が戻る（バッファは保持される）', () => {
    const session = new EditorSession(64, 64);
    session.apply(createBrushOp(BASE_LAYER_ID, line(40, 40, 60, 60, 8), P, 64, 64));
    session.resize(16, 16); // 内容の大半はキャンバス外へ
    session.resize(64, 64); // 戻す
    expect(statesEqual(session.state, replayAt(session))).toBe(true);
    // 合成画像（キャンバス座標）で (50,50) に内容が戻っている（白背景ではない＝赤寄り）。
    const flat = flattenState(session.state);
    const i = (50 * flat.width + 50) * 4;
    expect(flat.data[i]).toBeGreaterThan(flat.data[i + 1]); // R > G（赤）
    expect(flat.data[i + 1]).toBeLessThan(200); // 白背景(255)ではない
  });
});
