import type { EditorState, Operation, VariantAxis } from '../types';
import { getNode } from '../engine/editorState';
import { createSetLayerVisibilityOp } from '../engine/operations/layerOps';

// 空間軸（Variants）のロジック。React/DOM に依存しない純TS（テスト可能）。
// CONCEPT.md §3.1 / PLAN.md §2.3。

/**
 * 軸のセル選択を「表示/非表示 op 列」に変換する純関数。
 *
 * - exclusive: cellId のセルだけ visible=true、同じ軸の他セルは visible=false。
 * - toggle:    cellId のセルの現在の可視状態を反転（他セルは不変）。
 *
 * 既に目的の可視状態のノードには op を出さない（冗長 op を避け、consolidate を汚さない）。
 * 木に存在しない id・軸に属さない cellId は無視する。返す op は setLayerVisibility（klass=edit）
 * なので replay 整合（state === replay(log)）を保つ。
 */
export function selectionOps(axis: VariantAxis, state: EditorState, cellId: string): Operation[] {
  if (!axis.cells.some((c) => c.id === cellId)) return []; // 軸に属さないセルは無視
  const ops: Operation[] = [];
  const want = (id: string, visible: boolean) => {
    const node = getNode(state, id);
    if (!node || node.visible === visible) return; // 不在 or 既に目的状態なら op 不要
    ops.push(createSetLayerVisibilityOp(id, visible));
  };
  if (axis.mode === 'exclusive') {
    for (const cell of axis.cells) want(cell.id, cell.id === cellId);
  } else {
    const target = getNode(state, cellId);
    if (target) want(cellId, !target.visible);
  }
  return ops;
}

/** 軸の現在の選択セル（exclusive 用）。可視なセルの先頭 id。無ければ null。 */
export function selectedCellId(axis: VariantAxis, state: EditorState): string | null {
  for (const cell of axis.cells) {
    const node = getNode(state, cell.id);
    if (node?.visible) return cell.id;
  }
  return null;
}
