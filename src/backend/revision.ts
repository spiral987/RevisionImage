import type { Operation, Revision } from '../types';
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
