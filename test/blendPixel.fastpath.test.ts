import { describe, it, expect } from 'vitest';
import type { ImageBuffer } from '../src/types';
import { blendPixel } from '../src/engine/imageBuffer';

// 不透明高速パス(a>=1)が、従来の per-pixel ブレンド式とビット同一の結果になることを保証する。

// 最適化前の blendPixel と同一の式（参照実装）。
function blendRef(d: Uint8ClampedArray, idx: number, r: number, g: number, b: number, a: number) {
  if (a <= 0) return;
  const sa = a;
  const dr = d[idx] / 255;
  const dg = d[idx + 1] / 255;
  const dbb = d[idx + 2] / 255;
  const da = d[idx + 3] / 255;
  const outA = sa + da * (1 - sa);
  if (outA <= 0) { d[idx] = 0; d[idx + 1] = 0; d[idx + 2] = 0; d[idx + 3] = 0; return; }
  const sr = r / 255, sg = g / 255, sb = b / 255;
  d[idx] = Math.round(((sr * sa + dr * da * (1 - sa)) / outA) * 255);
  d[idx + 1] = Math.round(((sg * sa + dg * da * (1 - sa)) / outA) * 255);
  d[idx + 2] = Math.round(((sb * sa + dbb * da * (1 - sa)) / outA) * 255);
  d[idx + 3] = Math.round(outA * 255);
}

describe('blendPixel 不透明高速パス', () => {
  it('Math.round((v/255)*255) === v が 0..255 全域で成立（高速パスの代入が正しい根拠）', () => {
    for (let v = 0; v <= 255; v++) {
      expect(Math.round((v / 255) * 255)).toBe(v);
    }
  });

  it('a===1 で高速パスの出力が従来式とビット同一（背景・色を網羅）', () => {
    const dests: [number, number, number, number][] = [
      [0, 0, 0, 0],
      [255, 255, 255, 255],
      [123, 45, 200, 128],
      [10, 250, 7, 60],
      [200, 30, 30, 255],
    ];
    const srcs: [number, number, number][] = [
      [0, 0, 0],
      [255, 255, 255],
      [200, 30, 30],
      [1, 254, 128],
      [77, 88, 99],
    ];
    for (const dest of dests) {
      for (const [r, g, b] of srcs) {
        // 高速パス側（実装）
        const buf: ImageBuffer = { width: 1, height: 1, data: Uint8ClampedArray.from(dest) };
        blendPixel(buf, 0, 0, r, g, b, 1);
        // 参照側（旧式）
        const ref = Uint8ClampedArray.from(dest);
        blendRef(ref, 0, r, g, b, 1);
        expect(Array.from(buf.data)).toEqual(Array.from(ref));
        // 不透明合成なので結果は必ずソース色 + alpha 255。
        expect(Array.from(buf.data)).toEqual([r, g, b, 255]);
      }
    }
  });

  it('a<1 は従来経路のまま（半透明の結果が変わらない）', () => {
    const dest: [number, number, number, number] = [40, 80, 160, 200];
    for (const a of [0.05, 0.3, 0.5, 0.95]) {
      const buf: ImageBuffer = { width: 1, height: 1, data: Uint8ClampedArray.from(dest) };
      blendPixel(buf, 0, 0, 200, 30, 30, a);
      const ref = Uint8ClampedArray.from(dest);
      blendRef(ref, 0, 200, 30, 30, a);
      expect(Array.from(buf.data)).toEqual(Array.from(ref));
    }
  });
});
