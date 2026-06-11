import { describe, it, expect } from 'vitest';
import { EditorSession } from '../src/session';
import { createInitialState } from '../src/engine/editorState';
import { applyOperation } from '../src/engine/operation';
import { createAddImageLayerOp, createTransformOp } from '../src/engine/operations';
import type { ImageBuffer } from '../src/types';
import { asLayer, statesEqual } from './helpers';

function replay(session: EditorSession) {
  let s = createInitialState(session.width, session.height);
  for (const op of session.getLog()) s = applyOperation(s, op);
  return s;
}

function strip4(): ImageBuffer {
  // 4x1: x=0 赤, x=3 青, それ以外透明。
  const data = new Uint8ClampedArray(4 * 1 * 4);
  data.set([255, 0, 0, 255], 0);
  data.set([0, 0, 255, 255], 3 * 4);
  return { width: 4, height: 1, data };
}

describe('transform（拡大縮小・回転・反転）', () => {
  it('左右反転で赤と青が入れ替わる', () => {
    const s = new EditorSession(4, 1);
    s.apply(createAddImageLayerOp('img', 'img', strip4(), 0, 0, 4, 1));
    // 内容 bbox = x∈[0,4], 中心(2,0.5)。flip-H 行列。
    s.apply(createTransformOp('img', { a: -1, b: 0, c: 0, d: 1, e: 4, f: 0 }, 4, 1));

    const buf = asLayer(s.state.layers.find((l) => l.id === 'img')!).buffer;
    const px = (i: number) => [buf.data[i * 4], buf.data[i * 4 + 1], buf.data[i * 4 + 2], buf.data[i * 4 + 3]];
    expect(px(0)).toEqual([0, 0, 255, 255]); // 先頭が青に
    expect(px(3)).toEqual([255, 0, 0, 255]); // 末尾が赤に
    expect(statesEqual(s.state, replay(s))).toBe(true);
  });

  it('2倍拡大でバッファが拡大する', () => {
    const s = new EditorSession(4, 1);
    s.apply(createAddImageLayerOp('img', 'img', strip4(), 0, 0, 4, 1));
    // 中心(2,0.5)基準の 2倍: a=d=2, e=-2, f=-0.5
    s.apply(createTransformOp('img', { a: 2, b: 0, c: 0, d: 2, e: -2, f: -0.5 }, 4, 1));
    const layer = asLayer(s.state.layers.find((l) => l.id === 'img')!);
    expect(layer.buffer.width).toBe(8); // 4 → 8
    expect(layer.buffer.height).toBe(3); // 高さも拡大方向に伸びる
    expect(statesEqual(s.state, replay(s))).toBe(true);
  });

  it('恒等変換は内容を（ほぼ）保ち、不変条件を満たす', () => {
    const s = new EditorSession(4, 1);
    s.apply(createAddImageLayerOp('img', 'img', strip4(), 0, 0, 4, 1));
    s.apply(createTransformOp('img', { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }, 4, 1));
    const buf = asLayer(s.state.layers.find((l) => l.id === 'img')!).buffer;
    // 整数オフセットの恒等なので画素中心が一致し、元の色が保たれる。
    expect([buf.data[0], buf.data[1], buf.data[2], buf.data[3]]).toEqual([255, 0, 0, 255]);
    expect(statesEqual(s.state, replay(s))).toBe(true);
  });
});
