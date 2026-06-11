import type { Dag, Operation, Revision } from '../types';
import { ROOT_ID, addEdge, createDag } from './dag';
import { buildDag } from './dagBuilder';

/**
 * 確定済みリビジョン。SPEC の Revision に、確定時の操作列スナップショット(ops)を加えたもの。
 * ops は凍結（以後の編集はログの別スロットを置換/追加するだけで、ここで参照する op オブジェクトは
 * 変化しない）なので、リビジョンの状態は ops から決定的に再構築できる。
 */
export interface CommittedRevision extends Revision {
  ops: Operation[];
}

/** 操作列に対応する DAG の末端ノード（head = 子を持たないノード）を返す。 */
export function computeHeads(ops: readonly Operation[], width: number, height: number): string[] {
  const dag = buildDag(ops, width, height);
  const heads: string[] = [];
  for (const node of dag.nodes.values()) {
    if (node.id !== dag.rootId && node.children.length === 0) heads.push(node.id);
  }
  return heads.length ? heads : [dag.rootId];
}

/** 1つのブランチ（確定リビジョン or 作業ログ）= 操作列を持つもの。 */
export interface Branch {
  ops: readonly Operation[];
}

/**
 * 複数ブランチ（確定リビジョン群 + 作業ログ）を1つの統合DAGに重ね合わせる（統合 RevG 用）。
 *
 * 各ブランチを個別に Algorithm 1 で構築し、ノードは `op.id` で同一視して union、エッジも
 * (parentId → childId) を union する。狙い:
 *  - 共有プレフィックスは同一 id なので1ノードに畳まれる。
 *  - 分岐した固有操作はそれぞれ別の子として現れる（= フォーク）。
 *  - マージ済みリビジョンは両側の id を含むため、共通の子に複数の親が付く（= 合流）。
 *
 * 重要: 各ブランチDAGを**独立に**構築するため、別ブランチの（同一領域の）操作同士が
 * Algorithm 1 で直列化されることはない（branch isolation）。共有 id 間のエッジ向きは
 * 全ブランチで一致する（同じ操作・同じ生成順）ので、union しても巡回は生じない。
 */
export function buildUnifiedDag(
  branches: readonly Branch[],
  width: number,
  height: number,
): Dag {
  const unified = createDag(width, height); // root を含む
  const perBranch = branches.map((b) => buildDag(b.ops, width, height));

  // pass 1: ノードを id で union（root は既に存在）。
  for (const d of perBranch) {
    for (const node of d.nodes.values()) {
      if (node.id === ROOT_ID) continue;
      if (!unified.nodes.has(node.id)) {
        unified.nodes.set(node.id, { id: node.id, op: node.op, parents: [], children: [] });
      }
    }
  }
  // pass 2: エッジを union（addEdge は重複を張らない）。
  for (const d of perBranch) {
    for (const node of d.nodes.values()) {
      for (const childId of node.children) addEdge(unified, node.id, childId);
    }
  }
  return unified;
}
