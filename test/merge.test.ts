import { describe, it, expect } from 'vitest';
import '../src/engine/operations';
import { BASE_LAYER_ID } from '../src/engine/editorState';
import { Replayer } from '../src/backend/replayer';
import { flattenState } from '../src/engine/composite';
import { mergeDags, buildMergedOps, type MergeMode } from '../src/backend/merge';
import { createBrushOp } from '../src/engine/operations';
import { line } from './helpers';

const W = 64;
const H = 64;

// 指定座標を中心に塗りつぶす不透明ブラシ（領域がはっきり重なる/離れるようにする）。
function dot(color: [number, number, number], cx: number, cy: number, layer = BASE_LAYER_ID) {
  return createBrushOp(layer, line(cx, cy, cx, cy, 1), { color, size: 20, opacity: 1 }, W, H);
}

const RED: [number, number, number] = [255, 0, 0];
const BLUE: [number, number, number] = [0, 0, 255];

function pixelOf(ops: ReturnType<typeof dot>[], x: number, y: number): [number, number, number] {
  const flat = flattenState(new Replayer(W, H).replay(ops));
  const i = (y * W + x) * 4;
  return [flat.data[i], flat.data[i + 1], flat.data[i + 2]];
}

describe('Merge (Algorithm 2)', () => {
  it('衝突しない分岐操作は自動統合される', () => {
    const trunk = [dot(RED, 12, 12)]; // 左上
    const branch = [dot(BLUE, 52, 52)]; // 右下（領域が離れている）
    const { merged, conflicts } = mergeDags(trunk, branch, W, H);
    expect(conflicts).toHaveLength(0);
    // merged DAG に branch のノードが取り込まれている
    expect(merged.nodes.has(branch[0].id)).toBe(true);
    expect(merged.nodes.has(trunk[0].id)).toBe(true);

    const ops = buildMergedOps(trunk, branch, conflicts, new Map());
    expect(ops.map((o) => o.id).sort()).toEqual([trunk[0].id, branch[0].id].sort());
    // 両方の色が結果に存在
    expect(pixelOf(ops, 12, 12)).toEqual(RED);
    expect(pixelOf(ops, 52, 52)).toEqual(BLUE);
  });

  it('同一レイヤ・同一領域の操作は衝突として集約される', () => {
    const trunk = [dot(RED, 20, 20)];
    const branch = [dot(BLUE, 20, 20)]; // 同じ場所 → 衝突
    const { conflicts } = mergeDags(trunk, branch, W, H);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].trunkOps.map((o) => o.id)).toEqual([trunk[0].id]);
    expect(conflicts[0].branchOps.map((o) => o.id)).toEqual([branch[0].id]);
  });

  it('別レイヤの同一領域は衝突しない', () => {
    const trunk = [dot(RED, 20, 20, BASE_LAYER_ID)];
    const branch = [dot(BLUE, 20, 20, 'layer-2')];
    const { conflicts } = mergeDags(trunk, branch, W, H);
    expect(conflicts).toHaveLength(0);
  });

  it('4つの結合モードが切り替えられ、結果が変わる', () => {
    const trunk = [dot(RED, 20, 20)];
    const branch = [dot(BLUE, 20, 20)];
    const { conflicts } = mergeDags(trunk, branch, W, H);
    expect(conflicts).toHaveLength(1);
    const cid = conflicts[0].id;
    const res = (mode: MergeMode) => {
      const ops = buildMergedOps(trunk, branch, conflicts, new Map([[cid, mode]]));
      return pixelOf(ops, 20, 20);
    };
    expect(res('trunk-only')).toEqual(RED);
    expect(res('branch-only')).toEqual(BLUE);
    expect(res('trunk-after-branch')).toEqual(RED); // trunk が後 = 上書き
    expect(res('branch-after-trunk')).toEqual(BLUE); // branch が後 = 上書き
  });

  it('既定（解決指定なし）は trunk only', () => {
    const trunk = [dot(RED, 20, 20)];
    const branch = [dot(BLUE, 20, 20)];
    const { conflicts } = mergeDags(trunk, branch, W, H);
    const ops = buildMergedOps(trunk, branch, conflicts, new Map());
    expect(pixelOf(ops, 20, 20)).toEqual(RED);
  });

  it('共通プレフィックスがある分岐: 共通は重複せず、非衝突は両方残る', () => {
    const shared = dot(RED, 12, 12); // 左上（共通）
    const trunk = [shared, dot(RED, 30, 12)]; // trunk 固有（中央上）
    const branch = [shared, dot(BLUE, 12, 50)]; // branch 固有（左下, trunk と離れている）
    const { conflicts } = mergeDags(trunk, branch, W, H);
    expect(conflicts).toHaveLength(0);
    const ops = buildMergedOps(trunk, branch, conflicts, new Map());
    // shared が1回だけ
    expect(ops.filter((o) => o.id === shared.id)).toHaveLength(1);
    expect(ops).toHaveLength(3);
  });
});
