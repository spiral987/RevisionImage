import { describe, it, expect } from 'vitest';
import { EditorSession } from '../src/session';
import { BASE_LAYER_ID, createInitialState } from '../src/engine/editorState';
import { applyOperation } from '../src/engine/operation';
import {
  createAddLayerOp,
  createSetLayerVisibilityOp,
  createSetLayerOpacityOp,
  createRenameLayerOp,
  createRemoveLayerOp,
  createReorderLayerOp,
  createClearLayerOp,
  createMergeDownLayerOp,
  createBrushOp,
} from '../src/engine/operations';
import { layerContentBBox } from '../src/engine/layer';
import { line, statesEqual, asLayer, leafAt } from './helpers';

const W = 32;
const H = 32;

function replay(session: EditorSession) {
  let s = createInitialState(session.width, session.height);
  for (const op of session.getLog()) s = applyOperation(s, op);
  return s;
}

describe('レイヤー操作', () => {
  it('visibility/opacity/rename を適用でき、不変条件を保つ', () => {
    const s = new EditorSession(W, H);
    s.apply(createSetLayerVisibilityOp(BASE_LAYER_ID, false));
    s.apply(createSetLayerOpacityOp(BASE_LAYER_ID, 0.5));
    s.apply(createRenameLayerOp(BASE_LAYER_ID, 'BG'));
    const base = s.state.layers[0];
    expect(base.visible).toBe(false);
    expect(base.opacity).toBeCloseTo(0.5);
    expect(base.name).toBe('BG');
    expect(statesEqual(s.state, replay(s))).toBe(true);
  });

  it('連続 opacity 変更は last-wins で1エントリに統合される', () => {
    const s = new EditorSession(W, H);
    s.apply(createSetLayerOpacityOp(BASE_LAYER_ID, 0.8));
    s.apply(createSetLayerOpacityOp(BASE_LAYER_ID, 0.6));
    s.apply(createSetLayerOpacityOp(BASE_LAYER_ID, 0.4));
    expect(s.getLog().length).toBe(1);
    expect(s.state.layers[0].opacity).toBeCloseTo(0.4);
    expect(statesEqual(s.state, replay(s))).toBe(true);
  });

  it('削除は最低1レイヤを残し、active を付け替える', () => {
    const s = new EditorSession(W, H);
    s.apply(createAddLayerOp('L1', 'L1', W, H)); // active=L1
    expect(s.state.activeLayerId).toBe('L1');
    s.apply(createRemoveLayerOp('L1'));
    expect(s.state.layers.length).toBe(1);
    expect(s.state.activeLayerId).toBe(BASE_LAYER_ID);
    // 最後の1枚は削除されない。
    s.apply(createRemoveLayerOp(BASE_LAYER_ID));
    expect(s.state.layers.length).toBe(1);
    expect(statesEqual(s.state, replay(s))).toBe(true);
  });

  it('並べ替えで合成順（layers 配列順）が変わる', () => {
    const s = new EditorSession(W, H);
    s.apply(createAddLayerOp('L1', 'L1', W, H));
    s.apply(createAddLayerOp('L2', 'L2', W, H));
    // 並び: [base, L1, L2]
    expect(s.state.layers.map((l) => l.id)).toEqual([BASE_LAYER_ID, 'L1', 'L2']);
    s.apply(createReorderLayerOp('L2', 0)); // L2 を最背面へ
    expect(s.state.layers.map((l) => l.id)).toEqual(['L2', BASE_LAYER_ID, 'L1']);
    expect(statesEqual(s.state, replay(s))).toBe(true);
  });

  it('全消去でレイヤー内容が透明になり、不変条件を保つ', () => {
    const s = new EditorSession(32, 32);
    s.apply(createBrushOp(BASE_LAYER_ID, line(4, 4, 28, 28, 8), {
      color: [10, 20, 30],
      size: 6,
      opacity: 1,
    }, 32, 32));
    expect(layerContentBBox(asLayer(s.state.layers[0])).w).toBeGreaterThan(0); // 内容あり

    s.apply(createClearLayerOp(BASE_LAYER_ID, 32, 32));
    const layer = asLayer(s.state.layers[0]);
    expect(layer.buffer.data.every((v) => v === 0)).toBe(true); // 全透明
    expect(layer.offsetX).toBe(0);
    expect(statesEqual(s.state, replay(s))).toBe(true);
  });

  it('merge down は上のレイヤーを下へ焼き込み、1枚に統合する', () => {
    const s = new EditorSession(16, 16);
    s.apply(createAddLayerOp('L1', 'L1', 16, 16)); // 並び [base, L1], active=L1
    // base に赤、L1 に青を別位置で描く。
    s.apply(createBrushOp(BASE_LAYER_ID, line(2, 2, 2, 2, 1), { color: [255, 0, 0], size: 4, opacity: 1 }, 16, 16));
    s.apply(createBrushOp('L1', line(12, 12, 12, 12, 1), { color: [0, 0, 255], size: 4, opacity: 1 }, 16, 16));

    s.apply(createMergeDownLayerOp('L1'));
    expect(s.state.layers.length).toBe(1);
    expect(s.state.layers[0].id).toBe(BASE_LAYER_ID); // lower の id を引き継ぐ
    expect(s.state.activeLayerId).toBe(BASE_LAYER_ID);

    const buf = leafAt(s.state, 0).buffer;
    const at = (x: number, y: number) => {
      const i = (y * buf.width + x) * 4;
      return [buf.data[i], buf.data[i + 1], buf.data[i + 2], buf.data[i + 3]];
    };
    expect(at(2, 2)).toEqual([255, 0, 0, 255]); // base の赤が残る
    expect(at(12, 12)).toEqual([0, 0, 255, 255]); // L1 の青が焼き込まれる
    expect(statesEqual(s.state, replay(s))).toBe(true);
  });
});
