import { describe, it, expect } from 'vitest';
import { EditorSession } from '../src/session';
import { BASE_LAYER_ID, createInitialState } from '../src/engine/editorState';
import { applyOperation } from '../src/engine/operation';
import { createBrushOp, createFillOp, fillRegion } from '../src/engine/operations';
import { line, statesEqual } from './helpers';

const W = 24;
const H = 24;

function replay(session: EditorSession) {
  let s = createInitialState(W, H);
  for (const op of session.getLog()) s = applyOperation(s, op);
  return s;
}

describe('塗りつぶし (fill)', () => {
  it('連結した透明領域を不透明色で塗り、不変条件を保つ', () => {
    const session = new EditorSession(W, H);
    const region = fillRegion(session.state, BASE_LAYER_ID, 12, 12, 0);
    // 空レイヤは全面が同色(透明)なので全面が塗られる。
    expect(region.w).toBe(W);
    expect(region.h).toBe(H);

    session.apply(createFillOp(BASE_LAYER_ID, [10, 200, 40], 1, 12, 12, 0, region, W, H));
    const buf = session.state.layers[0].buffer;
    const i = (12 * buf.width + 12) * 4;
    expect([buf.data[i], buf.data[i + 1], buf.data[i + 2], buf.data[i + 3]]).toEqual([10, 200, 40, 255]);
    expect(statesEqual(session.state, replay(session))).toBe(true);
  });

  it('色境界を尊重する（tolerance=0 では別色の島を塗り替えない）', () => {
    const session = new EditorSession(W, H);
    // 中央に小さな不透明の青ダブ（中央配置なのでバッファは拡張されず 24×24 のまま）。
    session.apply(
      createBrushOp(
        BASE_LAYER_ID,
        line(12, 12, 12, 12, 1),
        { color: [0, 0, 255], size: 5, opacity: 1 },
        W,
        H,
      ),
    );
    // 透明な背景を端から赤で塗る（tolerance=0）。青ダブは色が違うので塗られない。
    const region = fillRegion(session.state, BASE_LAYER_ID, 1, 1, 0);
    session.apply(createFillOp(BASE_LAYER_ID, [255, 0, 0], 1, 1, 1, 0, region, W, H));

    const buf = session.state.layers[0].buffer;
    const at = (x: number, y: number) => {
      const i = (y * buf.width + x) * 4;
      return [buf.data[i], buf.data[i + 1], buf.data[i + 2], buf.data[i + 3]];
    };
    expect(at(1, 1)).toEqual([255, 0, 0, 255]); // 背景は赤
    expect(at(12, 12)).toEqual([0, 0, 255, 255]); // ダブ中心は青のまま
    expect(statesEqual(session.state, replay(session))).toBe(true);
  });

  it('種点がレイヤ外なら何も塗らない', () => {
    const session = new EditorSession(W, H);
    const before = session.state;
    session.apply(createFillOp(BASE_LAYER_ID, [1, 2, 3], 1, 999, 999, 0, { x: 0, y: 0, w: 0, h: 0 }, W, H));
    // 種点がバッファ外 → state 変化なし。
    expect(statesEqual(session.state, before)).toBe(true);
  });
});
