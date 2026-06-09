import { describe, it, expect } from 'vitest';
import '../src/engine/operations';
import { createInitialState, BASE_LAYER_ID } from '../src/engine/editorState';
import { applyOperation } from '../src/engine/operation';
import { flattenState } from '../src/engine/composite';
import { buffersEqual } from '../src/engine/imageBuffer';
import { Replayer } from '../src/backend/replayer';
import { createBrushOp, createTranslateOp, brushHandler } from '../src/engine/operations';
import { statesEqual, line } from './helpers';

const W = 40;
const H = 40;
const RED = { color: [255, 0, 0] as [number, number, number], size: 8, opacity: 1 };

describe('非破壊レイヤ移動 + バッファ拡張', () => {
  it('translate 後にキャンバス端へ描いてもバッファが拡張され描画される', () => {
    let s = createInitialState(W, H);
    // レイヤを右に 30px 移動（非破壊・オフセットのみ）
    s = applyOperation(s, createTranslateOp(BASE_LAYER_ID, 30, 0, W, H));
    expect(s.layers[0].offsetX).toBe(30);
    expect(s.layers[0].buffer.width).toBe(W); // まだ拡張されていない

    // キャンバス左端 (x=5) に描く → レイヤローカル x = 5-30 = -25 → 拡張が必要
    s = applyOperation(s, createBrushOp(BASE_LAYER_ID, line(5, 20, 5, 20, 1), RED, W, H));

    // バッファは左方向に拡張されている（オフセットも補正）
    expect(s.layers[0].buffer.width).toBeGreaterThan(W);
    expect(s.layers[0].offsetX).toBeLessThan(30);

    // 合成画像のキャンバス(5,20)に赤が見える
    const flat = flattenState(s);
    const idx = (20 * W + 5) * 4;
    expect(flat.data[idx]).toBeGreaterThan(200);
    expect(flat.data[idx + 3]).toBe(255);
  });

  it('translate→端へ描画 のシナリオでも replay がライブ状態とビット一致', () => {
    let s = createInitialState(W, H);
    const log = [
      createTranslateOp(BASE_LAYER_ID, -22, 12, W, H),
      createBrushOp(BASE_LAYER_ID, line(35, 2, 38, 6, 3), RED, W, H), // ローカルで右下にはみ出す
      createBrushOp(BASE_LAYER_ID, line(0, 38, 4, 39, 3), { ...RED, color: [0, 0, 255] }, W, H),
    ];
    for (const op of log) s = applyOperation(s, op);

    const replayed = new Replayer(W, H).replay(log);
    expect(statesEqual(replayed, s)).toBe(true);
  });

  it('バッファ拡張を伴うブラシでも consolidate == 逐次適用（不変条件）', () => {
    const base = applyOperation(createInitialState(W, H), createTranslateOp(BASE_LAYER_ID, 25, 25, W, H));
    const P = { color: [10, 200, 50] as [number, number, number], size: 9, opacity: 0.5 };
    const opA = createBrushOp(BASE_LAYER_ID, line(2, 2, 10, 10, 4), P, W, H); // ローカル負方向
    const opB = createBrushOp(BASE_LAYER_ID, line(35, 35, 39, 39, 4), P, W, H); // ローカル正方向

    const seq = applyOperation(applyOperation(base, opA), opB);
    const merged = brushHandler.consolidate!(opA, opB)!;
    const once = applyOperation(base, merged);

    expect(once.layers[0].buffer.width).toBe(seq.layers[0].buffer.width);
    expect(once.layers[0].buffer.height).toBe(seq.layers[0].buffer.height);
    expect(once.layers[0].offsetX).toBe(seq.layers[0].offsetX);
    expect(buffersEqual(seq.layers[0].buffer, once.layers[0].buffer)).toBe(true);
  });
});
