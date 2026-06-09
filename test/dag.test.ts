import { describe, it, expect } from 'vitest';
import '../src/engine/operations';
import type { Dag, Operation } from '../src/types';
import {
  createBrushOp,
  createTranslateOp,
  createBrightnessOp,
  createHueOp,
  createAddLayerOp,
} from '../src/engine/operations';
import { buildDag, insertNode } from '../src/backend/dagBuilder';
import { ROOT_ID, isAcyclic, edgeCount } from '../src/backend/dag';
import {
  dependent,
  semanticallyIndependent,
  bboxIntersect,
} from '../src/backend/dependency';
import { line } from './helpers';

const W = 64;
const H = 64;
const L1 = 'layer-base';
const L2 = 'layer-2';
const P = { color: [200, 30, 30] as [number, number, number], size: 4, opacity: 1 };

const dot = (layer: string, x: number, y: number) =>
  createBrushOp(layer, line(x, y, x, y, 1), P, W, H);
const span = (layer: string, x0: number, y0: number, x1: number, y1: number) =>
  createBrushOp(layer, line(x0, y0, x1, y1, 6), P, W, H);

/** ノード op の親IDを取得（ヘルパ）。 */
const parentsOf = (dag: Dag, op: Operation) => dag.nodes.get(op.id)!.parents;

describe('dependency 判定（原論文 §5）', () => {
  it('semanticallyIndependent: 上位3クラスの異クラスのみ true', () => {
    expect(semanticallyIndependent('rigid', 'color')).toBe(true);
    expect(semanticallyIndependent('rigid', 'deform')).toBe(true);
    expect(semanticallyIndependent('color', 'color')).toBe(false); // 同クラス
    expect(semanticallyIndependent('brush', 'color')).toBe(false); // brush が絡む
    expect(semanticallyIndependent('edit', 'rigid')).toBe(false); // edit が絡む
  });

  it('bboxIntersect: 重なり/接触/分離', () => {
    expect(bboxIntersect({ x: 0, y: 0, w: 10, h: 10 }, { x: 5, y: 5, w: 10, h: 10 })).toBe(true);
    expect(bboxIntersect({ x: 0, y: 0, w: 10, h: 10 }, { x: 10, y: 0, w: 10, h: 10 })).toBe(false); // 接触のみ
    expect(bboxIntersect({ x: 0, y: 0, w: 10, h: 10 }, { x: 20, y: 0, w: 10, h: 10 })).toBe(false);
  });

  it('dependent = 空間的に重なる AND 意味的に依存（領域ベース・原論文準拠）', () => {
    // 重なる・brush同士 → 依存
    expect(dependent(dot(L1, 10, 10), dot(L1, 11, 11))).toBe(true);
    // 重ならない → 独立（2台の車）
    expect(dependent(dot(L1, 5, 5), dot(L1, 55, 55))).toBe(false);
    // 別レイヤでも領域が重なれば依存（原論文は領域ベース。レイヤ所属では判定しない）
    expect(dependent(dot(L1, 10, 10), dot(L2, 10, 10))).toBe(true);
    // 全面・rigid と color → 意味的に独立 → 独立（平行移動と着色）
    expect(dependent(createTranslateOp(L1, 5, 5, W, H), createBrightnessOp(L1, 20, W, H))).toBe(false);
    // 全面・color と color → 意味的に依存 → 依存
    expect(dependent(createBrightnessOp(L1, 10, W, H), createHueOp(L1, 30, W, H))).toBe(true);
    // 空 region（内容なしの色調整など）はどれとも独立
    expect(dependent(createBrightnessOp(L1, 10, W, H, { x: 0, y: 0, w: 0, h: 0 }), dot(L1, 10, 10))).toBe(false);
  });
});

describe('DAG 構築（Algorithm 1）', () => {
  it('最初の操作はルートを親に持つ', () => {
    const dag = buildDag([dot(L1, 10, 10)], W, H);
    const op = [...dag.nodes.values()].find((n) => n.id !== ROOT_ID)!;
    expect(op.parents).toEqual([ROOT_ID]);
  });

  it('依存する操作は直列パスになる', () => {
    const a = span(L1, 5, 5, 20, 20);
    const b = span(L1, 10, 10, 25, 25); // a と重なる
    const dag = buildDag([a, b], W, H);
    expect(parentsOf(dag, a)).toEqual([ROOT_ID]);
    expect(parentsOf(dag, b)).toEqual([a.id]); // root→a→b の直列
  });

  it('独立な操作（重ならない領域）は並行パスになる', () => {
    const a = dot(L1, 8, 8);
    const b = dot(L1, 56, 56); // 重ならない
    const dag = buildDag([a, b], W, H);
    expect(parentsOf(dag, a)).toEqual([ROOT_ID]);
    expect(parentsOf(dag, b)).toEqual([ROOT_ID]); // 両方 root の子 = 並行
  });

  it('独立な操作（重ならない領域の色調整 と ブラシ）は並行（受け入れ条件・領域ベース）', () => {
    const brush = dot(L1, 10, 10); // 左上
    // 別レイヤの色調整。影響範囲は右下の内容領域に限定（重ならない）→ 並行。
    const color = createBrightnessOp(L2, 30, W, H, { x: 50, y: 50, w: 10, h: 10 });
    const dag = buildDag([brush, color], W, H);
    expect(parentsOf(dag, brush)).toEqual([ROOT_ID]);
    expect(parentsOf(dag, color)).toEqual([ROOT_ID]); // 並行
  });

  it('意味的に独立な操作（translate と brightness, 同レイヤ全面）は並行', () => {
    const t = createTranslateOp(L1, 7, 3, W, H);
    const b = createBrightnessOp(L1, 25, W, H);
    const dag = buildDag([t, b], W, H);
    expect(parentsOf(dag, b)).toEqual([ROOT_ID]); // translate には繋がらず並行
  });

  it('連結な依存群では最新ノードだけが親になる（祖先除外）', () => {
    const a = span(L1, 5, 5, 15, 15);
    const b = span(L1, 8, 8, 18, 18); // a と重なる → a に依存
    const c = span(L1, 10, 10, 20, 20); // a,b と重なる → 最新の b だけが親
    const dag = buildDag([a, b, c], W, H);
    expect(parentsOf(dag, b)).toEqual([a.id]);
    expect(parentsOf(dag, c)).toEqual([b.id]); // a は b の祖先なので除外される
  });

  it('複数の並行ブランチに依存する操作は複数親（マージ点）になる', () => {
    const a = dot(L1, 8, 8); // 左上
    const b = dot(L1, 56, 56); // 右下（a と独立）
    const c = span(L1, 8, 8, 56, 56); // a と b 両方に重なる
    const dag = buildDag([a, b, c], W, H);
    expect(parentsOf(dag, a)).toEqual([ROOT_ID]);
    expect(parentsOf(dag, b)).toEqual([ROOT_ID]);
    expect(parentsOf(dag, c).slice().sort()).toEqual([a.id, b.id].sort());
  });

  it('生成された DAG は常に非巡回', () => {
    const log = [
      span(L1, 5, 5, 20, 20),
      span(L1, 10, 10, 25, 25),
      dot(L1, 58, 58),
      createAddLayerOp(L2, 'Layer 1', W, H),
      dot(L2, 30, 30),
      createBrightnessOp(L2, 20, W, H),
      createTranslateOp(L1, 4, 4, W, H),
      span(L1, 8, 8, 56, 56),
    ];
    const dag = buildDag(log, W, H);
    expect(isAcyclic(dag)).toBe(true);
    // 全ノードが root + 操作数
    expect(dag.nodes.size).toBe(log.length + 1);
    expect(edgeCount(dag)).toBeGreaterThan(0);
  });

  it('addLayer は全面領域・editクラスの構造的チェックポイント（root に孤立しない）', () => {
    // 先に描画 → レイヤ追加 → 後続描画。addLayer(全面) は先行描画に依存して連結し、
    // 後続描画は addLayer に依存する（領域が重なる + edit は意味的依存）。
    const base = dot(L1, 40, 40);
    const add = createAddLayerOp(L2, 'Layer 1', W, H);
    const onNew = dot(L2, 20, 20);
    const dag = buildDag([base, add, onNew], W, H);
    expect(parentsOf(dag, base)).toEqual([ROOT_ID]);
    expect(parentsOf(dag, add)).toEqual([base.id]); // 先行操作に連結（root 孤立しない）
    expect(parentsOf(dag, onNew)).toEqual([add.id]); // 後続は addLayer に依存
  });

  it('insertNode を逐次呼んでも buildDag と同じ構造（incremental）', () => {
    const log = [dot(L1, 8, 8), dot(L1, 56, 56), span(L1, 8, 8, 56, 56)];
    const dag = buildDag([], W, H);
    for (const op of log) insertNode(dag, op);
    expect(isAcyclic(dag)).toBe(true);
    expect(parentsOf(dag, log[2]).slice().sort()).toEqual([log[0].id, log[1].id].sort());
  });
});
