import { describe, it, expect } from 'vitest';
import '../src/engine/operations';
import { createInitialState, BASE_LAYER_ID } from '../src/engine/editorState';
import { applyOperation } from '../src/engine/operation';
import { buffersEqual } from '../src/engine/imageBuffer';
import {
  createBrushOp,
  createEraserOp,
  createTranslateOp,
  createBrightnessOp,
  createHueOp,
  createAddLayerOp,
  brushHandler,
} from '../src/engine/operations';
import { statesEqual, line, leafAt } from './helpers';

const W = 64;
const H = 64;

/** 何か描き込んだ非自明な初期状態（色操作のテスト対象になるよう内容を持たせる）。 */
function paintedState() {
  let s = createInitialState(W, H);
  s = applyOperation(
    s,
    createBrushOp(BASE_LAYER_ID, line(8, 8, 56, 56, 9), { color: [200, 120, 40], size: 12, opacity: 1 }, W, H),
  );
  return s;
}

describe('operation determinism (同入力 → ビット一致)', () => {
  it('brush is deterministic and actually changes pixels', () => {
    const s0 = createInitialState(W, H);
    const strokes = line(10, 10, 50, 30, 7);
    const a = applyOperation(s0, createBrushOp(BASE_LAYER_ID, strokes, { color: [255, 0, 0], size: 8, opacity: 1 }, W, H));
    const b = applyOperation(s0, createBrushOp(BASE_LAYER_ID, strokes, { color: [255, 0, 0], size: 8, opacity: 1 }, W, H));
    expect(buffersEqual(leafAt(a, 0).buffer, leafAt(b, 0).buffer)).toBe(true);
    expect(buffersEqual(leafAt(a, 0).buffer, leafAt(s0, 0).buffer)).toBe(false);
  });

  it('apply does not mutate the input state (purity)', () => {
    const s0 = createInitialState(W, H);
    const before = new Uint8ClampedArray(leafAt(s0, 0).buffer.data);
    applyOperation(s0, createBrushOp(BASE_LAYER_ID, line(0, 0, 30, 30), { color: [1, 2, 3], size: 6, opacity: 1 }, W, H));
    expect(buffersEqual(leafAt(s0, 0).buffer, { width: W, height: H, data: before })).toBe(true);
  });

  it('all six operations are deterministic', () => {
    const base = paintedState();
    const ops = [
      () => createBrushOp(BASE_LAYER_ID, line(2, 60, 60, 2, 6, 0.7), { color: [0, 0, 255], size: 10, opacity: 0.6 }, W, H),
      () => createEraserOp(BASE_LAYER_ID, line(10, 10, 40, 40, 6), { size: 14, opacity: 0.8 }, W, H),
      () => createTranslateOp(BASE_LAYER_ID, 7, -3, W, H),
      () => createBrightnessOp(BASE_LAYER_ID, 37, W, H),
      () => createHueOp(BASE_LAYER_ID, 90, W, H),
      () => createAddLayerOp('layer-x', 'Extra', W, H),
    ];
    for (const make of ops) {
      const a = applyOperation(base, make());
      const b = applyOperation(base, make());
      expect(statesEqual(a, b)).toBe(true);
    }
  });

  it('brush consolidation (concat) == sequential application (Phase 2 の前提)', () => {
    const s0 = createInitialState(W, H);
    const params = { color: [10, 200, 50] as [number, number, number], size: 9, opacity: 0.5 };
    // 非連続な2ジェスチャ（opA の終点 ≠ opB の始点）。統合で偽の連結線が出ないことを検証する。
    const opA = createBrushOp(BASE_LAYER_ID, line(5, 5, 30, 30, 6), params, W, H);
    const opB = createBrushOp(BASE_LAYER_ID, line(48, 8, 58, 40, 6), params, W, H);

    const seq = applyOperation(applyOperation(s0, opA), opB);
    const merged = brushHandler.consolidate!(opA, opB)!;
    const once = applyOperation(s0, merged);

    expect(buffersEqual(leafAt(seq, 0).buffer, leafAt(once, 0).buffer)).toBe(true);
  });
});
