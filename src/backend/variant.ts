import type { EditorState, ImageBuffer, Operation, VariantAxis } from '../types';
import { getNode, updateNode } from '../engine/editorState';
import { isGroup, layerContentBBox } from '../engine/layer';
import { flattenState } from '../engine/composite';
import { cropBuffer } from '../engine/imageBuffer';
import { createSetLayerVisibilityOp } from '../engine/operations/layerOps';

// 空間軸（Variants）のロジック。React/DOM に依存しない純TS（テスト可能）。
// CONCEPT.md §3.1 / PLAN.md §2.3。

/**
 * 軸のセルをトグル（表示/非表示を反転）する op を返す純関数。各セルは独立に on/off する
 * （択一モードは廃止。N択1が要るときは将来 solo 操作として非モーダルに足す）。
 * 木に存在しない id・軸に属さない cellId は無視する。返す op は setLayerVisibility（klass=edit）
 * なので replay 整合（state === replay(log)）を保つ。
 */
export function selectionOps(axis: VariantAxis, state: EditorState, cellId: string): Operation[] {
  if (!axis.cells.some((c) => c.id === cellId)) return []; // 軸に属さないセルは無視
  const target = getNode(state, cellId);
  if (!target) return [];
  return [createSetLayerVisibilityOp(cellId, !target.visible)];
}

/**
 * セルのサムネイル用に「slot 内でこのセルだけ表示」した state を返す（合成文脈込み）。
 * 軸の他セルは非表示にし、slot 自体は可視にする。base（slot 以外）は現状のまま。
 * CONCEPT §4.2-1（セルは単独でなく合成順・合成文脈込みで見せる）への対応。state は変更せず複製を返す。
 */
export function cellPreviewState(
  state: EditorState,
  axis: VariantAxis,
  cellId: string,
): EditorState {
  let st = state;
  const slot = getNode(st, axis.slotId);
  if (slot && !slot.visible) st = updateNode(st, axis.slotId, (n) => ({ ...n, visible: true }));
  for (const cell of axis.cells) {
    const want = cell.id === cellId;
    const node = getNode(st, cell.id);
    if (node && node.visible !== want) st = updateNode(st, cell.id, (n) => ({ ...n, visible: want }));
  }
  return st;
}

/**
 * オニオンスキン用 state: slot 内の全セルを可視にし、いま隠れているセルは ghostOpacity に下げる
 * （表示中のセルは不透明のまま）。複数の別案を重ねて見る共在表示（CONCEPT §4.2-3 / §7）。
 * パネル内プレビュー専用で、メインキャンバスには重ねない（SideViews の重ね合わせ不可制約への配慮）。
 * state は変更せず複製を返す。
 */
export function onionSkinState(
  state: EditorState,
  axis: VariantAxis,
  ghostOpacity = 0.35,
): EditorState {
  let st = state;
  const slot = getNode(st, axis.slotId);
  if (slot && !slot.visible) st = updateNode(st, axis.slotId, (n) => ({ ...n, visible: true }));
  for (const cell of axis.cells) {
    const node = getNode(st, cell.id);
    if (!node) continue;
    const wasVisible = node.visible;
    st = updateNode(st, cell.id, (n) => ({
      ...n,
      visible: true,
      opacity: wasVisible ? n.opacity : ghostOpacity,
    }));
  }
  return st;
}

/** slot グループ直下の子（セル候補）を返す。slot がグループでなければ空。 */
export function slotChildren(
  state: EditorState,
  slotId: string,
): { id: string; name: string; isGroup: boolean }[] {
  const node = getNode(state, slotId);
  if (!node || !isGroup(node)) return [];
  return node.children.map((c) => ({ id: c.id, name: c.name, isGroup: isGroup(c) }));
}

/**
 * slot グループの「現在の見た目（合成結果）」を内容 bbox で切り出した素材ピースとして返す。
 * park（退避）で使う: 現在 slot に見えているものを 1 枚のスナップショットに焼く。
 * slot 自身とその子の現在の可視/不透明度を尊重して合成する。空なら null。
 */
export function slotPiece(
  state: EditorState,
  slotId: string,
): { buffer: ImageBuffer; x: number; y: number } | null {
  const node = getNode(state, slotId);
  if (!node) return null;
  // slot サブツリーだけを合成対象にした一時 state（base=透明）。
  const sub: EditorState = {
    width: state.width,
    height: state.height,
    layers: [node],
    activeLayerId: state.activeLayerId,
  };
  const flat = flattenState(sub, { background: [0, 0, 0, 0] });
  const bbox = layerContentBBox({
    id: '',
    name: '',
    buffer: flat,
    offsetX: 0,
    offsetY: 0,
    visible: true,
    opacity: 1,
  });
  if (bbox.w <= 0 || bbox.h <= 0) return null;
  return { buffer: cropBuffer(flat, bbox.x, bbox.y, bbox.w, bbox.h), x: bbox.x, y: bbox.y };
}

/** 軸の差し替え点に使えるグループ一覧（ツリー内の全グループ。depth はインデント表示用）。 */
export function listGroups(state: EditorState): { id: string; name: string; depth: number }[] {
  const out: { id: string; name: string; depth: number }[] = [];
  const walk = (nodes: EditorState['layers'], depth: number) => {
    for (const n of nodes) {
      if (isGroup(n)) {
        out.push({ id: n.id, name: n.name, depth });
        walk(n.children, depth + 1);
      }
    }
  };
  walk(state.layers, 0);
  return out;
}
