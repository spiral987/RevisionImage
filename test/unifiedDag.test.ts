import { describe, it, expect } from 'vitest';
import '../src/engine/operations';
import type { ImageBuffer } from '../src/types';
import { BASE_LAYER_ID } from '../src/engine/editorState';
import { Replayer } from '../src/backend/replayer';
import { flattenState } from '../src/engine/composite';
import { downsampleBuffer } from '../src/engine/imageBuffer';
import { ROOT_ID, isAcyclic } from '../src/backend/dag';
import { buildUnifiedDag, computeHeads } from '../src/backend/revision';
import { buildRevG } from '../src/backend/filters/importance';
import { createBrushOp } from '../src/engine/operations';
import { line } from './helpers';

const W = 64;
const H = 64;

// 指定座標を中心に塗る不透明ブラシ（領域がはっきり重なる/離れるように）。
function dot(color: [number, number, number], cx: number, cy: number, layer = BASE_LAYER_ID) {
  return createBrushOp(layer, line(cx, cy, cx, cy, 1), { color, size: 20, opacity: 1 }, W, H);
}

const RED: [number, number, number] = [255, 0, 0];
const BLUE: [number, number, number] = [0, 0, 255];
const GREEN: [number, number, number] = [0, 255, 0];

function flatsFor(ids: string[], allOpsById: Map<string, ReturnType<typeof dot>>): Map<string, ImageBuffer> {
  // テスト簡略化: 各ノードの縮小バッファ（importance 用）。ここでは個別 op を root に1つ適用した
  // 画像で十分（buildRevG は importance の相対値しか使わない）。
  const map = new Map<string, ImageBuffer>();
  const replayer = new Replayer(W, H);
  map.set(ROOT_ID, downsampleBuffer(flattenState(replayer.replay([])), 32, 32));
  for (const id of ids) {
    const op = allOpsById.get(id);
    if (op) map.set(id, downsampleBuffer(flattenState(replayer.replay([op])), 32, 32));
  }
  return map;
}

describe('統合DAG (buildUnifiedDag)', () => {
  it('共有プレフィックスは畳まれ、別ブランチの同一領域操作はフォークになる', () => {
    const shared = dot(RED, 30, 30); // 共通の起点（同一領域に後続が乗る）
    const b1 = dot(BLUE, 30, 30); // branch B 固有（shared と同領域 → 依存）
    const c1 = dot(GREEN, 30, 30); // branch C 固有（shared と同領域 → 依存）
    const B = [shared, b1];
    const C = [shared, c1];

    const u = buildUnifiedDag([{ ops: B }, { ops: C }], W, H);

    // root + shared + b1 + c1 = 4 ノード（shared は1つに畳まれる）。
    expect(u.nodes.size).toBe(4);
    expect(isAcyclic(u)).toBe(true);

    const sharedNode = u.nodes.get(shared.id)!;
    // shared から b1・c1 へフォーク。
    expect(sharedNode.children).toContain(b1.id);
    expect(sharedNode.children).toContain(c1.id);
    // b1 と c1 は互いに繋がらない（別ブランチで独立構築 → branch isolation）。
    expect(u.nodes.get(b1.id)!.children).toHaveLength(0);
    expect(u.nodes.get(c1.id)!.parents).not.toContain(b1.id);
  });

  it('マージ済みリビジョン（両側の id を含む）は合流点になる', () => {
    const shared = dot(RED, 30, 30);
    const b1 = dot(BLUE, 30, 30);
    const c1 = dot(GREEN, 30, 30);
    const B = [shared, b1];
    const C = [shared, c1];
    const M = [shared, b1, c1]; // マージ結果: 両側の op を取り込んだ列

    const u = buildUnifiedDag([{ ops: B }, { ops: C }, { ops: M }], W, H);

    expect(isAcyclic(u)).toBe(true);
    // M の DAG では同領域なので shared→b1→c1 と直列化される。union すると c1 の親は
    // {shared(Cより), b1(Mより)} となり合流（複数親）になる。
    const c1Node = u.nodes.get(c1.id)!;
    expect(c1Node.parents).toContain(b1.id);
    expect(c1Node.parents).toContain(shared.id);
    expect(c1Node.parents.length).toBeGreaterThanOrEqual(2);
  });

  it('離れた領域のブランチはそれぞれ root から枝分かれする', () => {
    const a = dot(RED, 12, 12); // 左上
    const b = dot(BLUE, 52, 52); // 右下（a と離れている）
    const u = buildUnifiedDag([{ ops: [a] }, { ops: [b] }], W, H);
    expect(u.nodes.size).toBe(3); // root + a + b
    expect(u.nodes.get(ROOT_ID)!.children).toEqual(expect.arrayContaining([a.id, b.id]));
  });

  it('コミット点(head)は forcedAnchors で低解像度でも常にアンカーとして残る', () => {
    const shared = dot(RED, 30, 30);
    const b1 = dot(BLUE, 30, 30);
    const c1 = dot(GREEN, 30, 30);
    const B = [shared, b1];
    const C = [shared, c1];
    const u = buildUnifiedDag([{ ops: B }, { ops: C }], W, H);

    const headsB = computeHeads(B, W, H); // [b1.id]
    const headsC = computeHeads(C, W, H); // [c1.id]
    const forced = new Set<string>([...headsB, ...headsC]);

    const flats = flatsFor([shared.id, b1.id, c1.id], new Map([
      [shared.id, shared],
      [b1.id, b1],
      [c1.id, c1],
    ]));

    // 最低解像度でも、両 head は個別アンカー（=自分自身が代表のクラスタ）として残る。
    const revg = buildRevG(u, flats, 0, forced);
    expect(revg.clusters.has(b1.id)).toBe(true);
    expect(revg.clusters.has(c1.id)).toBe(true);
    expect(revg.clusters.has(ROOT_ID)).toBe(true);
  });
});
