import type { BBox, Dag, Operation } from '../types';
import { ROOT_ID, bfsOrder, copyDag, descendantsOf } from './dag';
import { buildDag, insertNode } from './dagBuilder';
import { bboxIntersect } from './dependency';
import { unionBBox } from '../engine/geom';
import { genId } from '../util/id';

export type MergeMode = 'trunk-only' | 'branch-only' | 'trunk-after-branch' | 'branch-after-trunk';

/** 衝突グループ: 同一レイヤ・同一領域でぶつかる trunk 固有 op と branch 固有 op（+子孫）。 */
export interface ConflictGroup {
  id: string;
  trunkOps: Operation[];
  branchOps: Operation[];
  region: BBox;
}

export interface MergeResult {
  /** Algorithm 2 による自動統合後の DAG（非衝突の branch ノードを取り込んだもの）。 */
  merged: Dag;
  conflicts: ConflictGroup[];
}

/**
 * 2つの op が衝突するか。MVP の定義（SPEC §Phase6）: 同一レイヤ かつ 領域(bbox)が重なる。
 * = 同一ピクセル領域・同一対象を両立しない形で変更しうる。
 */
function opsConflict(a: Operation, b: Operation): boolean {
  return a.layerId === b.layerId && bboxIntersect(a.region, b.region);
}

/**
 * Algorithm 2: Automatic Merge（原論文 §5 / Algorithm 2 に忠実）。
 *
 *   Gm ← copy(Gi)                      // Gi=trunk, Gj=branch
 *   L  = nodes of Gj in BFS order
 *   while L not empty:
 *     v = pop_front(L)
 *     if v conflicts with nodes in Gm:
 *       remove children(=子孫) of v from L
 *       push v and its descendants into CL
 *     else:
 *       insert v into Gm with Algorithm 1
 *
 * 共通履歴のノード（id が trunk にも在る）は既に Gm にあるためスキップ。衝突判定の相手は
 * Gm 内の trunk 固有ノード（共通ノードは同一履歴なので衝突に数えない）。
 */
export function mergeDags(
  trunkOps: readonly Operation[],
  branchOps: readonly Operation[],
  width: number,
  height: number,
): MergeResult {
  const Gi = buildDag(trunkOps, width, height);
  const Gj = buildDag(branchOps, width, height);
  const Gm = copyDag(Gi);

  const branchIds = new Set(branchOps.map((o) => o.id));
  const isTrunkOnly = (id: string) => id !== ROOT_ID && !branchIds.has(id);

  const L = bfsOrder(Gj);
  const removed = new Set<string>();
  const conflicts: ConflictGroup[] = [];

  for (const v of L) {
    if (v.id === Gj.rootId) continue;
    if (removed.has(v.id)) continue;
    if (Gm.nodes.has(v.id)) continue; // 共通ノード（trunk にも在る）

    const conflictTrunk = [...Gm.nodes.values()].filter(
      (t) => isTrunkOnly(t.id) && opsConflict(t.op, v.op),
    );

    if (conflictTrunk.length > 0) {
      const descIds = descendantsOf(Gj, v.id);
      const groupIds = [v.id, ...descIds];
      const branchConflictOps: Operation[] = [];
      for (const id of groupIds) {
        removed.add(id);
        const node = Gj.nodes.get(id);
        if (node) branchConflictOps.push(node.op);
      }
      let region = v.op.region;
      for (const t of conflictTrunk) region = unionBBox(region, t.op.region);
      conflicts.push({
        id: genId('conflict'),
        trunkOps: conflictTrunk.map((t) => t.op),
        branchOps: branchConflictOps,
        region,
      });
    } else {
      insertNode(Gm, v.op); // Algorithm 1 で Gm に取り込む
    }
  }

  return { merged: Gm, conflicts };
}

/**
 * 衝突解決モードに従って、replay 可能な「マージ後の操作列」を構築する。
 * 非衝突部分（共通 + 双方の固有操作）は常に取り込み、衝突部分はモードで決定する。
 * 順序は timestamp 昇順。「after」モードでは後勝ち側を末尾側へずらして上書きを表現する
 * （[R] の latest 上書きを4モードに一般化）。
 */
export function buildMergedOps(
  trunkOps: readonly Operation[],
  branchOps: readonly Operation[],
  conflicts: readonly ConflictGroup[],
  resolutions: Map<string, MergeMode>,
): Operation[] {
  const AFTER = 1e15;
  const branchIds = new Set(branchOps.map((o) => o.id));
  const trunkIds = new Set(trunkOps.map((o) => o.id));
  const conflictTrunkIds = new Set<string>();
  const conflictBranchIds = new Set<string>();
  for (const c of conflicts) {
    c.trunkOps.forEach((o) => conflictTrunkIds.add(o.id));
    c.branchOps.forEach((o) => conflictBranchIds.add(o.id));
  }

  const items: { op: Operation; key: number }[] = [];
  // 共通履歴
  for (const o of trunkOps) if (branchIds.has(o.id)) items.push({ op: o, key: o.timestamp });
  // 非衝突 trunk 固有
  for (const o of trunkOps)
    if (!branchIds.has(o.id) && !conflictTrunkIds.has(o.id)) items.push({ op: o, key: o.timestamp });
  // 非衝突 branch 固有
  for (const o of branchOps)
    if (!trunkIds.has(o.id) && !conflictBranchIds.has(o.id)) items.push({ op: o, key: o.timestamp });

  for (const c of conflicts) {
    const mode = resolutions.get(c.id) ?? 'trunk-only';
    if (mode === 'trunk-only') {
      for (const o of c.trunkOps) items.push({ op: o, key: o.timestamp });
    } else if (mode === 'branch-only') {
      for (const o of c.branchOps) items.push({ op: o, key: o.timestamp });
    } else if (mode === 'trunk-after-branch') {
      for (const o of c.branchOps) items.push({ op: o, key: o.timestamp });
      for (const o of c.trunkOps) items.push({ op: o, key: o.timestamp + AFTER });
    } else {
      for (const o of c.trunkOps) items.push({ op: o, key: o.timestamp });
      for (const o of c.branchOps) items.push({ op: o, key: o.timestamp + AFTER });
    }
  }

  items.sort((a, b) => a.key - b.key); // 安定ソート（同 key は挿入順）

  // id 重複は最後の出現位置を採用（after 上書きの意図を尊重）。
  const seen = new Set<string>();
  const out: Operation[] = [];
  for (let i = items.length - 1; i >= 0; i--) {
    if (seen.has(items[i].op.id)) continue;
    seen.add(items[i].op.id);
    out.unshift(items[i].op);
  }
  return out;
}
