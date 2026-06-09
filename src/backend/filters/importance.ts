import type { Dag, ImageBuffer, Operation } from '../../types';
import { bfsOrder } from '../dag';

// visual importance filter（原論文 §5.3 / REFERENCE §6）。
// v(n) = (1/w) Σ_{m∈N(n)} I(n,m)·A(n,m)
//  N(n): DAG上で距離 w(=2) 以内の近傍
//  I(n,m): act(n)/act(m) 適用後画像の低レベルピクセル差分
//  A(n,m): type/params が異なれば 10^d、同一なら 1、addLayer は 100

const NEIGHBOR_W = 2;

/** RevG の1ノード（1つ以上の DAG ノードの集約）。 */
export interface RevGCluster {
  id: string; // アンカー（代表）DAGノードID
  op: Operation; // 代表op
  memberIds: string[]; // 集約された元DAGノードID（自身を含む）
  parents: string[]; // クラスタ間の親（アンカーID）
  children: string[];
}

export interface RevGGraph {
  rootId: string;
  clusters: Map<string, RevGCluster>;
}

function undirectedAdj(dag: Dag): Map<string, string[]> {
  const adj = new Map<string, string[]>();
  for (const n of dag.nodes.values()) adj.set(n.id, []);
  for (const n of dag.nodes.values()) {
    for (const c of n.children) {
      adj.get(n.id)!.push(c);
      adj.get(c)!.push(n.id);
    }
  }
  return adj;
}

/** start から距離 maxDist 以内の近傍（start 自身は除く）→ 距離。 */
function neighborsWithin(adj: Map<string, string[]>, start: string, maxDist: number): Map<string, number> {
  const dist = new Map<string, number>([[start, 0]]);
  const queue = [start];
  while (queue.length) {
    const cur = queue.shift()!;
    const d = dist.get(cur)!;
    if (d >= maxDist) continue;
    for (const nb of adj.get(cur) ?? []) {
      if (!dist.has(nb)) {
        dist.set(nb, d + 1);
        queue.push(nb);
      }
    }
  }
  dist.delete(start);
  return dist;
}

/** 同サイズバッファの平均絶対RGB差（0..1）。 */
function imageDiff(a: ImageBuffer, b: ImageBuffer): number {
  const da = a.data;
  const db = b.data;
  if (da.length !== db.length || da.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < da.length; i += 4) {
    sum += Math.abs(da[i] - db[i]) + Math.abs(da[i + 1] - db[i + 1]) + Math.abs(da[i + 2] - db[i + 2]);
  }
  return sum / ((da.length / 4) * 3 * 255);
}

/** アクションコンテキスト項 A(n,m)。 */
function actionContext(n: Operation, m: Operation, d: number): number {
  if (n.type === 'addLayer' || m.type === 'addLayer') return 100;
  const same = n.type === m.type && JSON.stringify(n.params) === JSON.stringify(m.params);
  return same ? 1 : Math.pow(10, d);
}

/** 各 DAG ノードの視覚的重要度 v(n)。flatById は各ノード結果画像（縮小可）。 */
export function computeImportance(dag: Dag, flatById: Map<string, ImageBuffer>): Map<string, number> {
  const adj = undirectedAdj(dag);
  const imp = new Map<string, number>();
  for (const node of dag.nodes.values()) {
    const neigh = neighborsWithin(adj, node.id, NEIGHBOR_W);
    let sum = 0;
    for (const [mId, d] of neigh) {
      const fn = flatById.get(node.id);
      const fm = flatById.get(mId);
      const m = dag.nodes.get(mId);
      if (!fn || !fm || !m) continue;
      sum += imageDiff(fn, fm) * actionContext(node.op, m.op, d);
    }
    imp.set(node.id, sum / NEIGHBOR_W);
  }
  return imp;
}

/**
 * 解像度に応じて DAG を多重解像度 RevG に集約する。
 * resolution=1 で DAG そのまま（全ノード）、小さくするほど重要度の高いノードだけを
 * アンカーとして残し、他はそのアンカー（祖先方向で最初に出会うアンカー）へ吸収する。
 * 集約後にクラスタ間でエッジを張り直す。スライダーでノード数が連続的に増減する。
 */
export function buildRevG(
  dag: Dag,
  flatById: Map<string, ImageBuffer>,
  resolution: number,
): RevGGraph {
  const root = dag.rootId;
  const imp = computeImportance(dag, flatById);
  const nonRoot = [...dag.nodes.values()].filter((n) => n.id !== root);
  const total = nonRoot.length;

  const keep = total === 0 ? 0 : Math.max(1, Math.round(total * Math.max(0, Math.min(1, resolution))));
  const anchors = new Set<string>([root]);
  const sorted = [...nonRoot].sort((a, b) => (imp.get(b.id) ?? 0) - (imp.get(a.id) ?? 0));
  for (let i = 0; i < keep && i < sorted.length; i++) anchors.add(sorted[i].id);
  if (resolution >= 1) for (const n of nonRoot) anchors.add(n.id);

  // 各ノードを所属アンカーへ割り当て（BFS順=親が先に確定）。
  const clusterOf = new Map<string, string>();
  for (const node of bfsOrder(dag)) {
    if (anchors.has(node.id)) {
      clusterOf.set(node.id, node.id);
    } else {
      const p = node.parents.find((pid) => clusterOf.has(pid));
      clusterOf.set(node.id, p ? clusterOf.get(p)! : root);
    }
  }

  const clusters = new Map<string, RevGCluster>();
  for (const id of anchors) {
    const node = dag.nodes.get(id)!;
    clusters.set(id, { id, op: node.op, memberIds: [], parents: [], children: [] });
  }
  for (const [nodeId, cId] of clusterOf) clusters.get(cId)?.memberIds.push(nodeId);

  for (const node of dag.nodes.values()) {
    for (const childId of node.children) {
      const a = clusterOf.get(node.id)!;
      const b = clusterOf.get(childId)!;
      if (a !== b) {
        const ca = clusters.get(a)!;
        const cb = clusters.get(b)!;
        if (!ca.children.includes(b)) ca.children.push(b);
        if (!cb.parents.includes(a)) cb.parents.push(a);
      }
    }
  }

  return { rootId: root, clusters };
}
