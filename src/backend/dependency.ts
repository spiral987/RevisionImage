import type { BBox, OpClass, Operation } from '../types';

/**
 * 操作間の依存判定（原論文 §5 "Operation dependency"）。
 *
 * 原論文の定義: 「2操作は、**領域が重ならなければ**空間的に独立。Table 1 の上位3クラス
 * (rigid/deform/color) は互いに意味的に独立。**意味的に独立な操作は同一領域でも並行パスに置く。**」
 * Abstract も「並行パス = 意味的(例: 平行移動と変形) または 空間的(例: 2台の車を別々に着色)に独立」と明記。
 *
 *   independent ⇔ (spatially independent) OR (semantically independent)
 *   ∴ dependent ⇔ (spatial overlap) AND (semantically dependent)
 *
 * 注意1: SPEC/REFERENCE の擬似コードは `dependent = spatial OR semantic` だが、これは誤り。
 * OR だと「別図形を塗る→独立」「translation と color は同領域でも並行」という論文の例に反する。
 * 原論文本文に従い AND を採用する。
 *
 * 注意2: 空間的依存は**画像領域(bbox)の重なり**で判定する（原論文どおり。レイヤ所属では判定しない）。
 * layer ID は再生・重要度付けのメタデータ。これを成立させるため color/translate の region は全面では
 * なく実際の影響範囲（レイヤ内容bbox）を用いる（= 原論文の selection mask 相当）。
 */

const TOP3: ReadonlySet<OpClass> = new Set<OpClass>(['rigid', 'deform', 'color']);

/** bbox が（面積を持って）交差するか。境界が接するだけ(共有面積0)は交差としない。 */
export function bboxIntersect(a: BBox, b: BBox): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

/**
 * 意味的に独立か。双方が上位3クラス(rigid/deform/color)で、かつクラスが異なる場合のみ true。
 * 同一クラス、または edit/brush が絡む場合は意味的に依存（false）。
 */
export function semanticallyIndependent(a: OpClass, b: OpClass): boolean {
  return TOP3.has(a) && TOP3.has(b) && a !== b;
}

/**
 * 空間的に重なるか。原論文どおり画像領域(bbox)の交差のみで判定する（レイヤは問わない）。
 * 空 region（w=0 または h=0）はどれとも交差しない＝空間的に独立。
 */
export function spatialOverlap(a: Operation, b: Operation): boolean {
  return bboxIntersect(a.region, b.region);
}

/**
 * 挿入対象 a と既存ノード b が依存とみなされるか。
 * dependent = 空間的に重なる AND 意味的に依存。
 */
export function dependent(a: Operation, b: Operation): boolean {
  return spatialOverlap(a, b) && !semanticallyIndependent(a.klass, b.klass);
}
