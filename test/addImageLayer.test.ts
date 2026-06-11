import { describe, it, expect } from 'vitest';
import { EditorSession } from '../src/session';
import { createInitialState } from '../src/engine/editorState';
import { applyOperation } from '../src/engine/operation';
import { createAddImageLayerOp } from '../src/engine/operations';
import { bufferToBase64, base64ToBuffer } from '../src/engine/imageBuffer';
import type { ImageBuffer } from '../src/types';
import { statesEqual, asLayer } from './helpers';

const W = 32;
const H = 32;

function gradientImage(w: number, h: number): ImageBuffer {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      data[i] = (x * 7) & 255;
      data[i + 1] = (y * 11) & 255;
      data[i + 2] = (x * y) & 255;
      data[i + 3] = 255;
    }
  }
  return { width: w, height: h, data };
}

describe('addImageLayer', () => {
  it('base64 エンコード/デコードがビット同一で往復する', () => {
    const buf = gradientImage(16, 12);
    const back = base64ToBuffer(bufferToBase64(buf), 16, 12);
    expect(back.width).toBe(16);
    expect(back.height).toBe(12);
    expect(Array.from(back.data)).toEqual(Array.from(buf.data));
  });

  it('画像レイヤを配置し、log だけから決定的に replay できる', () => {
    const session = new EditorSession(W, H);
    const buf = gradientImage(20, 16);
    session.apply(createAddImageLayerOp('img-1', 'photo', buf, 4, 6, W, H));

    // 配置されたレイヤの画素・オフセットが入力どおり。
    const layer = asLayer(session.state.layers.find((l) => l.id === 'img-1')!);
    expect(layer.offsetX).toBe(4);
    expect(layer.offsetY).toBe(6);
    expect(layer.buffer.width).toBe(20);
    expect(Array.from(layer.buffer.data)).toEqual(Array.from(buf.data));

    // log を頭から再適用して state と一致（不変条件）。
    let s = createInitialState(W, H);
    for (const op of session.getLog()) s = applyOperation(s, op);
    expect(statesEqual(s, session.state)).toBe(true);
  });
});
