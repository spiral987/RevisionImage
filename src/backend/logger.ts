import type { Operation } from '../types';
import { getHandler } from '../engine/operation';

/**
 * Logger（SPEC §7 / 原論文 5.1）。
 * 操作を配列に append し、連続する同型・同レイヤ操作を consolidate（統合）する。
 * 統合の可否と方法は各操作ハンドラの consolidate に委譲する。
 *
 * 純TS（React/DOM 非依存）。backend は engine の上位レイヤなので engine への依存は正しい。
 */
export class Logger {
  private log: Operation[] = [];
  /**
   * この index 未満の op は「確定済み」（commit / checkout / undo・redo・load で復元）扱いで、
   * consolidate の吸収対象にしない。
   *
   * 理由: consolidate は統合結果に prev.id を引き継ぐ（ブラシ等）。確定済み op に新ストロークを
   * 吸収させると「同一 id なのに内容が違う」状態が生まれ、`同一 id ⟹ 同一内容（共有履歴）` という
   * 不変条件が壊れる。これは merge（共有祖先の識別）・統合DAG/RevG が依存する前提なので致命的だった
   * （= 別ブランチで描いた変更が共有ノードと誤認され、無視・衝突未検出になっていた）。
   * バリアより後の「ライブな未確定 op」同士だけ統合すれば、確定済み op の id↔内容 は保たれる。
   */
  private barrier = 0;

  append(op: Operation): void {
    // 直前 op がバリアより後（=ライブ未確定）のときだけ統合を試みる。
    if (this.log.length > this.barrier) {
      const last = this.log[this.log.length - 1];
      if (last.type === op.type && last.layerId === op.layerId) {
        const merged = getHandler(op.type)?.consolidate?.(last, op);
        if (merged) {
          this.log[this.log.length - 1] = merged;
          return;
        }
      }
    }
    this.log.push(op);
  }

  getLog(): readonly Operation[] {
    return this.log;
  }

  /** ログを置換（checkout/undo/redo/load 用、consolidate せず厳密復元）。全 op を確定扱いにする。 */
  setLog(ops: readonly Operation[]): void {
    this.log = [...ops];
    this.barrier = this.log.length;
  }

  /** 現在のログを確定扱いにする（commit 後に呼び、以後の編集が確定 op へ吸収されないようにする）。 */
  freeze(): void {
    this.barrier = this.log.length;
  }

  get length(): number {
    return this.log.length;
  }

  clear(): void {
    this.log = [];
    this.barrier = 0;
  }
}
