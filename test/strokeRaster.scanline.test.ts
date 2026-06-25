import { describe, it, expect } from 'vitest';
import type { ImageBuffer, StrokePoint } from '../src/types';
import { stampDab, type StampFn } from '../src/engine/strokeRaster';

// スキャンライン化した stampCircle が、最適化前の per-pixel 実装とビット同一の
// 「(x, y, alpha) スタンプ列」を生成することを保証する回帰テスト。
// stampCircle は非公開なので、それを 1 ダブ呼ぶだけの公開 API stampDab 経由で検証する。

interface Stamped {
  x: number;
  y: number;
  a: number;
}

// 最適化前の stampCircle と同一アルゴリズム（参照実装）。stampDab(offset 0, pressure 1) は
// stampCircle(cx=p.x, cy=p.y, radius) と等価なのでこれと比較できる。
function naiveStamps(cx: number, cy: number, radius: number): Stamped[] {
  const out: Stamped[] = [];
  if (radius <= 0) return out;
  const x0 = Math.floor(cx - radius - 1);
  const x1 = Math.ceil(cx + radius + 1);
  const y0 = Math.floor(cy - radius - 1);
  const y1 = Math.ceil(cy + radius + 1);
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const dx = x + 0.5 - cx;
      const dy = y + 0.5 - cy;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const coverage = radius - dist + 0.5;
      if (coverage > 0) out.push({ x, y, a: coverage > 1 ? 1 : coverage });
    }
  }
  return out;
}

// stampDab を呼んで実際にスタンプされた (x, y, alpha) 列を順序込みで記録する。
function optimizedStamps(cx: number, cy: number, radius: number): Stamped[] {
  const out: Stamped[] = [];
  const buf: ImageBuffer = { width: 0, height: 0, data: new Uint8ClampedArray(0) };
  const record: StampFn = (_b, x, y, a) => out.push({ x, y, a });
  const p: StrokePoint = { x: cx, y: cy, pressure: 1 };
  stampDab(buf, p, radius, 0, 0, record);
  return out;
}

describe('stampCircle スキャンライン化のビット一致', () => {
  // 小半径(内部最適化が効かない rinSafe<=0)〜大半径まで、整数/分数中心を網羅。
  const radii = [0.6, 1, 1.4, 1.5, 2, 3.3, 5, 8, 12.7, 20, 40, 79.5];
  const centers = [
    [10, 10],
    [10.5, 10.5],
    [10.25, 10.75],
    [0.3, 0.7],
    [-5.4, 3.2],
    [100.9, -2.1],
  ];

  for (const r of radii) {
    for (const [cx, cy] of centers) {
      it(`r=${r} center=(${cx},${cy}) が参照実装とスタンプ列まで一致`, () => {
        const ref = naiveStamps(cx, cy, r);
        const opt = optimizedStamps(cx, cy, r);
        // 同じ画素を同じ順序・同じ alpha でスタンプする（順序まで一致 = 重なり描画も同一結果）。
        // 大半径では画素数が多いため per-pixel の expect を避け、最初の不一致だけを報告する。
        expect(opt.length).toBe(ref.length);
        let mismatch: string | null = null;
        for (let i = 0; i < ref.length; i++) {
          // alpha は Object.is で -0/NaN 含めビット一致を要求。
          if (opt[i].x !== ref[i].x || opt[i].y !== ref[i].y || !Object.is(opt[i].a, ref[i].a)) {
            mismatch = `#${i}: ref=${JSON.stringify(ref[i])} opt=${JSON.stringify(opt[i])}`;
            break;
          }
        }
        expect(mismatch).toBeNull();
      });
    }
  }
});
