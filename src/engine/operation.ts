import type { EditorState, Operation, OpClass } from '../types';

/**
 * 操作ハンドラ。各操作は「決定的な純関数」(SPEC §6)として apply を実装する:
 *   同じ入力 state + 同じ op  →  必ずビット同一の出力 state。
 */
export interface OpHandler {
  type: string;
  klass: OpClass;
  /** state を変更せず、新しい state を返す純関数。 */
  apply(state: EditorState, op: Operation): EditorState;
  /**
   * 連続する同型・同レイヤ操作の統合（consolidate, SPEC §7 / 原論文 5.1）。
   * prev に next を統合した op を返す。統合不可なら null。
   *
   * 重要な不変条件: ここで返す統合 op を prev の直前状態に1回適用した結果は、
   * prev → next を逐次適用した結果とビット同一でなければならない。
   * （これにより state == replay(log) が常に成り立ち、Phase 2 の往復一致が保証される。）
   * その性質が厳密に成り立つ操作（brush/eraser=点列連結, translate=オフセット加算）のみ
   * consolidate を実装する。clamp により非結合となる色操作は実装しない。
   */
  consolidate?(prev: Operation, next: Operation): Operation | null;
}

const registry = new Map<string, OpHandler>();

export function registerOp(handler: OpHandler): void {
  registry.set(handler.type, handler);
}

export function getHandler(type: string): OpHandler | undefined {
  return registry.get(type);
}

/**
 * すべての編集が通る単一の関数（SPEC §6）。
 * UI のボタン/ブラシ操作は直接 canvas を触らず、必ず Operation を生成してここに渡す。
 */
export function applyOperation(state: EditorState, op: Operation): EditorState {
  const handler = registry.get(op.type);
  if (!handler) {
    throw new Error(`No handler registered for operation type: ${op.type}`);
  }
  return handler.apply(state, op);
}
