import { describe, it, expect } from 'vitest';
import '../src/engine/operations';
import type { ImageBuffer } from '../src/types';
import { BASE_LAYER_ID } from '../src/engine/editorState';
import { Replayer } from '../src/backend/replayer';
import { flattenState } from '../src/engine/composite';
import { downsampleBuffer } from '../src/engine/imageBuffer';
import { buildDag } from '../src/backend/dagBuilder';
import { ROOT_ID } from '../src/backend/dag';
import { buildRevG, computeImportance } from '../src/backend/filters/importance';
import { createBrushOp } from '../src/engine/operations';
import { line } from './helpers';

const W = 64;
const H = 64;
const P = { color: [200, 30, 30] as [number, number, number], size: 8, opacity: 1 };
const dot = (x: number, y: number) => createBrushOp(BASE_LAYER_ID, line(x, y, x, y, 1), P, W, H);

function flatsFor(ops: ReturnType<typeof dot>[]): Map<string, ImageBuffer> {
  const states = new Replayer(W, H).replayAll(ops);
  const map = new Map<string, ImageBuffer>();
  map.set(ROOT_ID, downsampleBuffer(flattenState(states[0]), 32, 32));
  ops.forEach((op, i) => map.set(op.id, downsampleBuffer(flattenState(states[i + 1]), 32, 32)));
  return map;
}

describe('visual importance filter / 多重解像度', () => {
  const ops = [dot(10, 10), dot(40, 40), dot(20, 50), dot(55, 15), dot(30, 30)];
  const dag = buildDag(ops, W, H);
  const flats = flatsFor(ops);

  it('全ノードに有限の importance が割り当てられる', () => {
    const imp = computeImportance(dag, flats);
    expect(imp.size).toBe(dag.nodes.size);
    for (const v of imp.values()) expect(Number.isFinite(v)).toBe(true);
  });

  it('resolution=1 で DAG そのまま（全ノードが個別クラスタ）', () => {
    const revg = buildRevG(dag, flats, 1);
    expect(revg.clusters.size).toBe(dag.nodes.size);
    for (const c of revg.clusters.values()) expect(c.memberIds).toHaveLength(1);
  });

  it('解像度を下げるとクラスタ数が単調に減る（連続的な増減）', () => {
    const counts = [1, 0.75, 0.5, 0.25, 0].map((r) => buildRevG(dag, flats, r).clusters.size);
    for (let i = 1; i < counts.length; i++) {
      expect(counts[i]).toBeLessThanOrEqual(counts[i - 1]);
    }
    expect(counts[counts.length - 1]).toBeLessThan(counts[0]); // 粗い方は確実に少ない
  });

  it('集約後も全 DAG ノードがいずれかのクラスタに属し、root は常にアンカー', () => {
    const revg = buildRevG(dag, flats, 0);
    const members = new Set<string>();
    for (const c of revg.clusters.values()) c.memberIds.forEach((m) => members.add(m));
    expect(members.size).toBe(dag.nodes.size);
    expect(revg.clusters.has(ROOT_ID)).toBe(true);
  });

  it('集約クラスタのエッジは自己ループを含まない', () => {
    const revg = buildRevG(dag, flats, 0.4);
    for (const c of revg.clusters.values()) {
      expect(c.children).not.toContain(c.id);
      expect(c.parents).not.toContain(c.id);
    }
  });
});
