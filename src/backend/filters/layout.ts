import dagre from 'dagre';
import type { Dag } from '../../types';

// layout filter（原論文 §5.3）: 古典的な階層レイアウト（Gansner et al. 1993 相当）を
// dagre で計算し、各 RevG ノードの座標・エッジ経路を決める。DOM 非依存（純TS）。

export interface RevGNodeLayout {
  id: string;
  x: number; // 中心座標
  y: number;
  width: number;
  height: number;
}

export interface RevGEdgeLayout {
  from: string;
  to: string;
  points: { x: number; y: number }[];
}

export interface RevGLayout {
  nodes: Map<string, RevGNodeLayout>;
  edges: RevGEdgeLayout[];
  width: number;
  height: number;
}

export interface LayoutOptions {
  nodeWidth?: number;
  nodeHeight?: number;
  rankSep?: number;
  nodeSep?: number;
  rankdir?: 'TB' | 'LR';
}

/** parents/children を持つ任意のノード列を配置する（DAG でも集約後の RevG クラスタでも使える）。 */
export function layoutNodes(
  inputNodes: Iterable<{ id: string; children: string[] }>,
  opts: LayoutOptions = {},
): RevGLayout {
  const nodeWidth = opts.nodeWidth ?? 80;
  const nodeHeight = opts.nodeHeight ?? 78;
  const list = [...inputNodes];

  const g = new dagre.graphlib.Graph();
  g.setGraph({
    rankdir: opts.rankdir ?? 'TB',
    ranksep: opts.rankSep ?? 40,
    nodesep: opts.nodeSep ?? 24,
    marginx: 8,
    marginy: 8,
  });
  g.setDefaultEdgeLabel(() => ({}));

  const ids = new Set(list.map((n) => n.id));
  for (const node of list) {
    g.setNode(node.id, { width: nodeWidth, height: nodeHeight });
  }
  for (const node of list) {
    for (const childId of node.children) {
      if (ids.has(childId)) g.setEdge(node.id, childId);
    }
  }

  dagre.layout(g);

  const nodes = new Map<string, RevGNodeLayout>();
  for (const id of g.nodes()) {
    const n = g.node(id);
    nodes.set(id, { id, x: n.x, y: n.y, width: n.width, height: n.height });
  }

  const edges: RevGEdgeLayout[] = [];
  for (const e of g.edges()) {
    const ge = g.edge(e);
    edges.push({ from: e.v, to: e.w, points: ge.points ?? [] });
  }

  const graph = g.graph();
  return { nodes, edges, width: graph.width ?? 0, height: graph.height ?? 0 };
}

export function layoutDag(dag: Dag, opts: LayoutOptions = {}): RevGLayout {
  return layoutNodes(dag.nodes.values(), opts);
}
