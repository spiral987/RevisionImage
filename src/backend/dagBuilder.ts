import type { Dag, DagNode, Operation } from '../types';
import { addEdge, ancestors, createDag, postOrderDFS } from './dag';
import { dependent } from './dependency';

/**
 * Algorithm 1: Node Insertion（原論文 §5 / Algorithm 1 に忠実）。
 *
 *   P = {}                      // c の親候補
 *   L = nodes in post-order DFS
 *   while L not empty:
 *     v = pop_front(L)
 *     if dependent(c, v):
 *       P = P ∪ {v}
 *       remove ancestors(v) from L   // v の祖先方向を候補から除外
 *   add directed edges from each node in P to c
 *
 * 後順DFS（子=最新が先頭）で走査し、依存ノードを見つけたらその祖先を候補から除外することで、
 * 「連結な依存ノード群のうち最新の代表だけ」を親に残す。並行する別ブランチの依存ノードは
 * 互いに祖先関係に無いため両方残り、c は複数親（マージ点）になりうる。
 *
 * ルート: 依存ノードが1つも見つからなければ（孤立操作なら）ルートを親にする。ルートは全ノードの
 * 祖先なので、他の依存ノードが選ばれた時点で必ず ancestors として候補から外れる。
 */
export function insertNode(dag: Dag, op: Operation): void {
  const L = postOrderDFS(dag); // c を追加する前の既存ノード集合
  const removed = new Set<string>();
  const parents: string[] = [];

  for (const v of L) {
    if (removed.has(v.id)) continue;
    if (v.id === dag.rootId || dependent(op, v.op)) {
      parents.push(v.id);
      for (const anc of ancestors(dag, v.id)) removed.add(anc);
    }
  }

  const node: DagNode = { id: op.id, op, parents: [], children: [] };
  dag.nodes.set(node.id, node);
  for (const pid of parents) addEdge(dag, pid, node.id);
}

/** 操作ログを先頭から1つずつ挿入して DAG を構築する。 */
export function buildDag(log: readonly Operation[], width: number, height: number): Dag {
  const dag = createDag(width, height);
  for (const op of log) insertNode(dag, op);
  return dag;
}
