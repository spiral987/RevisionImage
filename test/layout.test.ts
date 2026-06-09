import { describe, it, expect } from 'vitest';
import '../src/engine/operations';
import { buildDag } from '../src/backend/dagBuilder';
import { ROOT_ID } from '../src/backend/dag';
import { layoutDag } from '../src/backend/filters/layout';
import { createBrushOp } from '../src/engine/operations';
import { line } from './helpers';

const W = 64;
const H = 64;
const P = { color: [0, 0, 0] as [number, number, number], size: 4, opacity: 1 };
const span = (x0: number, y0: number, x1: number, y1: number) =>
  createBrushOp('L', line(x0, y0, x1, y1, 4), P, W, H);

describe('layout filter (dagre)', () => {
  it('全ノードに有限座標が割り当てられ、エッジ数が一致する', () => {
    const a = span(5, 5, 15, 15);
    const b = span(8, 8, 18, 18); // a に依存（直列）
    const dag = buildDag([a, b], W, H);
    const layout = layoutDag(dag);

    expect(layout.nodes.size).toBe(dag.nodes.size); // root + 2
    for (const id of dag.nodes.keys()) {
      const n = layout.nodes.get(id);
      expect(n).toBeDefined();
      expect(Number.isFinite(n!.x)).toBe(true);
      expect(Number.isFinite(n!.y)).toBe(true);
      expect(n!.width).toBeGreaterThan(0);
      expect(n!.height).toBeGreaterThan(0);
    }
    // エッジ数 = root→a, a→b
    let edges = 0;
    for (const node of dag.nodes.values()) edges += node.children.length;
    expect(layout.edges.length).toBe(edges);
    expect(layout.width).toBeGreaterThan(0);
    expect(layout.height).toBeGreaterThan(0);
  });

  it('直列DAGは子が親より下に配置される（rankdir TB）', () => {
    const a = span(5, 5, 15, 15);
    const b = span(8, 8, 18, 18);
    const dag = buildDag([a, b], W, H);
    const layout = layoutDag(dag);
    const root = layout.nodes.get(ROOT_ID)!;
    const na = layout.nodes.get(a.id)!;
    const nb = layout.nodes.get(b.id)!;
    expect(na.y).toBeGreaterThan(root.y);
    expect(nb.y).toBeGreaterThan(na.y);
  });

  it('並行な操作は同じ rank（近い y）に並ぶ', () => {
    const a = createBrushOp('L', line(5, 5, 8, 8, 2), P, W, H); // 左上
    const b = createBrushOp('L', line(55, 55, 58, 58, 2), P, W, H); // 右下（独立）
    const dag = buildDag([a, b], W, H);
    const layout = layoutDag(dag);
    const na = layout.nodes.get(a.id)!;
    const nb = layout.nodes.get(b.id)!;
    expect(Math.abs(na.y - nb.y)).toBeLessThan(5); // 同じ階層
    expect(na.x).not.toBe(nb.x); // 横に並ぶ
  });
});
