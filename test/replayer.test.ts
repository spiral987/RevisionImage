import { describe, it, expect } from 'vitest';
import { EditorSession } from '../src/session';
import { Replayer } from '../src/backend/replayer';
import { createInitialState, BASE_LAYER_ID } from '../src/engine/editorState';
import { applyOperation } from '../src/engine/operation';
import { flattenState } from '../src/engine/composite';
import { buffersEqual } from '../src/engine/imageBuffer';
import {
  createBrushOp,
  createTranslateOp,
  createBrightnessOp,
  createHueOp,
  createAddLayerOp,
  createEraserOp,
} from '../src/engine/operations';
import { statesEqual, line } from './helpers';

const W = 80;
const H = 60;

/** consolidation・複数レイヤ・色操作を含む現実的な編集列を持つセッションを作る。 */
function buildSession(): EditorSession {
  const s = new EditorSession(W, H);
  const P = { color: [210, 40, 40] as [number, number, number], size: 11, opacity: 0.8 };
  s.apply(createBrushOp(BASE_LAYER_ID, line(5, 5, 40, 40, 6), P, W, H));
  s.apply(createBrushOp(BASE_LAYER_ID, line(50, 8, 72, 30, 6), P, W, H)); // ← 前のブラシと統合(非連続)
  s.apply(createTranslateOp(BASE_LAYER_ID, 6, -4, W, H));
  s.apply(createTranslateOp(BASE_LAYER_ID, -2, 3, W, H)); // ← 前の translate と統合
  s.apply(createAddLayerOp('layer-2', 'Layer 1', W, H));
  s.apply(createBrushOp('layer-2', line(0, 0, 60, 50, 7), { ...P, color: [30, 60, 200] }, W, H));
  s.apply(createEraserOp('layer-2', line(10, 10, 30, 30, 4), { size: 16, opacity: 1 }, W, H));
  s.apply(createBrightnessOp('layer-2', 35, W, H));
  s.apply(createHueOp('layer-2', 110, W, H));
  return s;
}

describe('Replayer (Phase 2)', () => {
  it('受け入れ条件: ログだけからの full replay がライブ状態とビット一致', () => {
    const s = buildSession();
    const r = new Replayer(W, H);
    const replayed = r.replay(s.getLog());
    expect(statesEqual(replayed, s.state)).toBe(true);
  });

  it('合成画像レベルでも replay とライブが一致', () => {
    const s = buildSession();
    const r = new Replayer(W, H);
    const live = flattenState(s.state);
    const replayed = r.replayToImage(s.getLog());
    expect(buffersEqual(live, replayed)).toBe(true);
  });

  it('replay は実行ごとに決定的（同一結果）', () => {
    const s = buildSession();
    const r = new Replayer(W, H);
    expect(statesEqual(r.replay(s.getLog()), r.replay(s.getLog()))).toBe(true);
  });

  it('upTo で先頭 k 操作後の中間状態が得られる（サムネイル用）', () => {
    const s = buildSession();
    const log = s.getLog();
    const r = new Replayer(W, H);
    let manual = createInitialState(W, H);
    for (let k = 0; k <= log.length; k++) {
      expect(statesEqual(r.replay(log, k), manual)).toBe(true);
      if (k < log.length) manual = applyOperation(manual, log[k]);
    }
  });

  it('upTo=0 はルート、範囲外はクランプ', () => {
    const s = buildSession();
    const log = s.getLog();
    const r = new Replayer(W, H);
    const root = createInitialState(W, H);
    expect(statesEqual(r.replay(log, 0), root)).toBe(true);
    expect(statesEqual(r.replay(log, -5), root)).toBe(true);
    expect(statesEqual(r.replay(log, 9999), r.replay(log))).toBe(true);
  });

  it('replayAll は [root, after#1, ..., after#N] を返す', () => {
    const s = buildSession();
    const log = s.getLog();
    const r = new Replayer(W, H);
    const all = r.replayAll(log);
    expect(all.length).toBe(log.length + 1);
    expect(statesEqual(all[0], createInitialState(W, H))).toBe(true);
    for (let k = 0; k <= log.length; k++) {
      expect(statesEqual(all[k], r.replay(log, k))).toBe(true);
    }
  });

  it('「全消去 → replay」で元に戻る（往復シナリオ）', () => {
    const s = buildSession();
    const log = s.getLog().map((op) => op); // ログを保持
    const r = new Replayer(W, H);
    const snapshot = flattenState(s.state);
    // キャンバス全消去に相当: 新しい空状態へ。ログだけから復元する。
    const restored = r.replay(log);
    expect(buffersEqual(flattenState(restored), snapshot)).toBe(true);
  });
});
