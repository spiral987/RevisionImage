import type { Dag, DagNode, Operation } from '../types';
import { fullCanvas } from '../engine/geom';

/** ルートノード（初期化操作）のID。各リビジョン = ルートを含む部分グラフ（原論文 §3）。 */
export const ROOT_ID = 'root';

/** ルート = 初期化操作（空キャンバスを開く / 画像ロード）。全ノードの祖先。 */
export function createRootOp(width: number, height: number): Operation {
  return {
    id: ROOT_ID,
    type: 'init',
    klass: 'edit',
    params: { width, height },
    region: fullCanvas(width, height),
    layerId: '',
    timestamp: 0,
  };
}

export function createDag(width: number, height: number): Dag {
  const root: DagNode = { id: ROOT_ID, op: createRootOp(width, height), parents: [], children: [] };
  const nodes = new Map<string, DagNode>();
  nodes.set(ROOT_ID, root);
  return { rootId: ROOT_ID, nodes };
}

/** parent → child の有向エッジを張る（重複は張らない）。 */
export function addEdge(dag: Dag, parentId: string, childId: string): void {
  const p = dag.nodes.get(parentId);
  const c = dag.nodes.get(childId);
  if (!p || !c) return;
  if (!p.children.includes(childId)) p.children.push(childId);
  if (!c.parents.includes(parentId)) c.parents.push(parentId);
}

/**
 * 後順DFS（子を先に出力し親を後に出力）。結果[0] が最も深い子孫（=最新）、末尾が root。
 * Algorithm 1 はこの順で走査して「連結な依存ノード群の最新の代表」を親に選ぶ。
 */
export function postOrderDFS(dag: Dag): DagNode[] {
  const result: DagNode[] = [];
  const visited = new Set<string>();
  const visit = (id: string): void => {
    if (visited.has(id)) return;
    visited.add(id);
    const node = dag.nodes.get(id);
    if (!node) return;
    for (const childId of node.children) visit(childId);
    result.push(node);
  };
  visit(dag.rootId);
  return result;
}

/** ノード id の全祖先（parents を辿って到達可能なノードID集合）。id 自身は含まない。 */
export function ancestors(dag: Dag, id: string): Set<string> {
  const result = new Set<string>();
  const node = dag.nodes.get(id);
  if (!node) return result;
  const stack = [...node.parents];
  while (stack.length) {
    const cur = stack.pop()!;
    if (result.has(cur)) continue;
    result.add(cur);
    const n = dag.nodes.get(cur);
    if (n) stack.push(...n.parents);
  }
  return result;
}

/** DAG が非巡回か（children をたどって back-edge が無いか）。 */
export function isAcyclic(dag: Dag): boolean {
  const state = new Map<string, number>(); // 0=未訪問, 1=スタック中, 2=完了
  const dfs = (id: string): boolean => {
    state.set(id, 1);
    const node = dag.nodes.get(id);
    if (node) {
      for (const childId of node.children) {
        const s = state.get(childId) ?? 0;
        if (s === 1) return false; // 再帰スタックに戻る → 巡回
        if (s === 0 && !dfs(childId)) return false;
      }
    }
    state.set(id, 2);
    return true;
  };
  for (const id of dag.nodes.keys()) {
    if ((state.get(id) ?? 0) === 0 && !dfs(id)) return false;
  }
  return true;
}

/** エッジ総数（テスト/表示用）。 */
export function edgeCount(dag: Dag): number {
  let n = 0;
  for (const node of dag.nodes.values()) n += node.children.length;
  return n;
}

/** 幅優先（BFS）順。Algorithm 2（Merge）で branch のノードを走査する順序。 */
export function bfsOrder(dag: Dag): DagNode[] {
  const result: DagNode[] = [];
  const visited = new Set<string>([dag.rootId]);
  const queue: string[] = [dag.rootId];
  while (queue.length) {
    const id = queue.shift()!;
    const node = dag.nodes.get(id);
    if (!node) continue;
    result.push(node);
    for (const c of node.children) {
      if (!visited.has(c)) {
        visited.add(c);
        queue.push(c);
      }
    }
  }
  return result;
}

/** ノード id の全子孫（children を辿って到達可能なID集合）。id 自身は含まない。 */
export function descendantsOf(dag: Dag, id: string): Set<string> {
  const result = new Set<string>();
  const node = dag.nodes.get(id);
  if (!node) return result;
  const stack = [...node.children];
  while (stack.length) {
    const cur = stack.pop()!;
    if (result.has(cur)) continue;
    result.add(cur);
    const n = dag.nodes.get(cur);
    if (n) stack.push(...n.children);
  }
  return result;
}

/** DAG の浅いコピー（op は共有、parents/children 配列は複製）。Merge の Gm←Gi に使う。 */
export function copyDag(dag: Dag): Dag {
  const nodes = new Map<string, DagNode>();
  for (const node of dag.nodes.values()) {
    nodes.set(node.id, {
      id: node.id,
      op: node.op,
      parents: [...node.parents],
      children: [...node.children],
    });
  }
  return { rootId: dag.rootId, nodes };
}
