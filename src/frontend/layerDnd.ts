// レイヤーパネルの D&D 並べ替えの index 計算（純関数・テスト可能）。
// レイヤーパネルは「上=最前面」で配列を逆順表示するため、視覚上の above/below は
// 配列インデックスでは反転する。さらに moveNode は「対象を除去してから挿入」するので、
// 同一親内で前方から後方へ動かすときは 1 つ詰まる分を補正する。

/**
 * ドロップ位置を moveNode に渡す挿入インデックスへ変換する。
 * @param pos 視覚上、対象ノードの above(上) か below(下) か。
 * @param targetIndex 対象ノードの、親 children 配列内インデックス。
 * @param fromIndexSameParent ドラッグ元が同じ親にある場合その元インデックス、別親なら null。
 */
export function reorderIndex(
  pos: 'above' | 'below',
  targetIndex: number,
  fromIndexSameParent: number | null,
): number {
  // 逆順表示: 視覚 above（前面側）= 配列で index 大 → targetIndex+1。
  let idx = pos === 'above' ? targetIndex + 1 : targetIndex;
  // 同一親で元が挿入位置より前なら、除去で 1 つ詰まる。
  if (fromIndexSameParent !== null && fromIndexSameParent < idx) idx -= 1;
  return idx;
}
