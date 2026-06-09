import { describe, it, expect } from 'vitest';
import { EditorSession } from '../src/session';
import { applyOperation } from '../src/engine/operation';
import { createInitialState, BASE_LAYER_ID } from '../src/engine/editorState';
import {
  createBrushOp,
  createTranslateOp,
  createBrightnessOp,
  createHueOp,
  createAddLayerOp,
} from '../src/engine/operations';
import { statesEqual, line } from './helpers';

const W = 64;
const H = 64;

/** ログを頭から再適用する Phase 1 版ミニ replay（Phase 2 の Replayer の核）。 */
function replay(width: number, height: number, log: readonly ReturnType<typeof createBrushOp>[]) {
  let s = createInitialState(width, height);
  for (const op of log) s = applyOperation(s, op);
  return s;
}

describe('session の不変条件: state === replay(log)', () => {
  it('consolidate を含む編集列でも往復一致する', () => {
    const session = new EditorSession(W, H);
    const P = { color: [220, 30, 30] as [number, number, number], size: 10, opacity: 0.7 };

    // 同一パラメータのブラシ3回（→ 1エントリに統合される）。互いに非連続な位置にして、
    // 統合時に偽の連結線が出ないこと（= replay と一致すること）も検証する。
    session.apply(createBrushOp(BASE_LAYER_ID, line(5, 5, 25, 25, 5), P, W, H));
    session.apply(createBrushOp(BASE_LAYER_ID, line(40, 5, 55, 30, 5), P, W, H));
    session.apply(createBrushOp(BASE_LAYER_ID, line(8, 50, 30, 58, 5), P, W, H));

    // translate 2回（→ 統合）
    session.apply(createTranslateOp(BASE_LAYER_ID, 4, 2, W, H));
    session.apply(createTranslateOp(BASE_LAYER_ID, -1, 3, W, H));

    // 新規レイヤ + そのレイヤへブラシ + 色操作（統合されない）
    session.apply(createAddLayerOp('layer-2', 'Layer 1', W, H));
    session.apply(createBrushOp('layer-2', line(0, 0, 40, 40, 6), { ...P, color: [20, 40, 200] }, W, H));
    session.apply(createBrightnessOp('layer-2', 40, W, H));
    session.apply(createHueOp('layer-2', 75, W, H));

    // ログは統合済み（少なくともブラシ3→1, translate2→1 で総数が削減される）
    const log = session.getLog();
    expect(log.length).toBe(6); // brush, translate, addLayer, brush, brightness, hue

    const replayed = replay(W, H, log as never);
    expect(statesEqual(session.state, replayed)).toBe(true);
  });
});
