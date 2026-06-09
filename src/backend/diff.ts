import type { Operation } from '../types';

/**
 * Revision Diff（原論文 §4 / REFERENCE §4）。
 *
 * 2リビジョン（= 2つの操作集合 / DAG部分グラフ）の差分を求める。グラフ同型判定（NP完全）は避け、
 * **ノードのラベル一致**で共通ノードを抽出する。本実装ではラベル = 操作の id（アクションログ由来の
 * 一意な記録）。分岐時、共通履歴のノードは同一 id を共有する設計なので id 一致 = 同一操作。
 * 異なる id は「実際に同じでも差分として扱う」（原論文が許容する近似）。
 */
export interface OpDiff {
  /** 両リビジョンに含まれる操作（a の順序）。 */
  common: Operation[];
  /** a のみに含まれる操作。 */
  onlyA: Operation[];
  /** b のみに含まれる操作。 */
  onlyB: Operation[];
  /** 先頭から id が一致する連続操作数（差分アニメのベースライン位置）。 */
  commonPrefix: number;
}

export function diffOps(a: readonly Operation[], b: readonly Operation[]): OpDiff {
  const idsA = new Set(a.map((o) => o.id));
  const idsB = new Set(b.map((o) => o.id));

  const common = a.filter((o) => idsB.has(o.id));
  const onlyA = a.filter((o) => !idsB.has(o.id));
  const onlyB = b.filter((o) => !idsA.has(o.id));

  let commonPrefix = 0;
  const min = Math.min(a.length, b.length);
  while (commonPrefix < min && a[commonPrefix].id === b[commonPrefix].id) commonPrefix++;

  return { common, onlyA, onlyB, commonPrefix };
}
