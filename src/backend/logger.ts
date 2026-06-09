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

  append(op: Operation): void {
    const last = this.log[this.log.length - 1];
    if (last && last.type === op.type && last.layerId === op.layerId) {
      const merged = getHandler(op.type)?.consolidate?.(last, op);
      if (merged) {
        this.log[this.log.length - 1] = merged;
        return;
      }
    }
    this.log.push(op);
  }

  getLog(): readonly Operation[] {
    return this.log;
  }

  /** ログを与えられた操作列で置き換える（checkout 用。consolidate せず厳密に復元）。 */
  setLog(ops: readonly Operation[]): void {
    this.log = [...ops];
  }

  get length(): number {
    return this.log.length;
  }

  clear(): void {
    this.log = [];
  }
}
