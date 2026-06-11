import type { Dag, EditorState, Operation } from './types';
import { applyOperation } from './engine/operation';
import { createInitialState } from './engine/editorState';
import './engine/operations'; // 操作ハンドラを登録
import { Logger } from './backend/logger';
import { buildDag } from './backend/dagBuilder';
import { computeHeads, type CommittedRevision } from './backend/revision';
import { genId } from './util/id';

/**
 * Engine（純粋な applyOperation）と Backend（Logger）を束ねる編集セッション。
 * UI はすべての編集をこの apply() に通す（SPEC §6 の「単一関数」の実体）。
 *
 * 不変条件: this.state === replay(logger.getLog())。
 *   apply は受け取った op を「そのまま」現在状態に逐次適用する一方、Logger は
 *   別途 consolidate する。consolidate は「逐次適用と統合1回適用がビット同一」になる
 *   操作にのみ実装されているため、この不変条件は常に保たれ Phase 2 の往復一致を保証する。
 */
export class EditorSession {
  state: EditorState;
  readonly logger = new Logger();
  revisions: CommittedRevision[] = [];
  width: number;
  height: number;

  /**
   * Undo/Redo はログ全体のスナップショット列で管理する。
   * 各 apply の「直前」のログを undoStack に積む（1 ジェスチャ = 1 スナップショット）。
   * consolidate で複数ブラシが 1 エントリに統合されても、apply 単位でスナップショットを
   * 取るため Undo は 1 ジェスチャずつ戻る。スナップショットは（不変な）op 参照の配列コピー
   * なので軽量。state は常に restore で log から決定的に再構築し、不変条件を保つ。
   */
  private undoStack: Operation[][] = [];
  private redoStack: Operation[][] = [];
  private static readonly MAX_UNDO = 200;

  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
    this.state = createInitialState(width, height);
  }

  apply(op: Operation): EditorState {
    this.pushUndoSnapshot();
    this.redoStack = [];
    this.state = applyOperation(this.state, op);
    this.logger.append(op);
    return this.state;
  }

  private pushUndoSnapshot(): void {
    this.undoStack.push([...this.logger.getLog()]);
    if (this.undoStack.length > EditorSession.MAX_UNDO) this.undoStack.shift();
  }

  /** ログを ops で置き換え、state を決定的に再構築する（checkout/undo/redo の共通処理）。 */
  private restore(ops: readonly Operation[]): void {
    this.logger.setLog(ops);
    let s = createInitialState(this.width, this.height);
    for (const op of ops) s = applyOperation(s, op);
    this.state = s;
  }

  canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  /** 直前のジェスチャを取り消す。戻したら true。 */
  undo(): boolean {
    const prev = this.undoStack.pop();
    if (!prev) return false;
    this.redoStack.push([...this.logger.getLog()]);
    this.restore(prev);
    return true;
  }

  /** 取り消したジェスチャをやり直す。やり直したら true。 */
  redo(): boolean {
    const next = this.redoStack.pop();
    if (!next) return false;
    this.undoStack.push([...this.logger.getLog()]);
    this.restore(next);
    return true;
  }

  getLog(): readonly Operation[] {
    return this.logger.getLog();
  }

  /** 現在のログから DAG（Algorithm 1）を構築する。RevG 可視化(Phase 4)の入力。 */
  getDag(): Dag {
    return buildDag(this.getLog(), this.width, this.height);
  }

  /** 現在の操作列をリビジョンとして確定（commit / check-in）する。 */
  commitRevision(label?: string): CommittedRevision {
    const ops = this.getLog().map((o) => o); // スナップショット（凍結）
    const rev: CommittedRevision = {
      id: genId('rev'),
      label: label && label.trim() ? label.trim() : `rev ${this.revisions.length + 1}`,
      headIds: computeHeads(ops, this.width, this.height),
      ops,
      timestamp: Date.now(),
    };
    this.revisions.push(rev);
    return rev;
  }

  /**
   * 指定した操作列を作業状態として読み込む（checkout）。以後の編集はこの状態から分岐する。
   * Merge やリビジョン間の作業切り替えに使う。ログは consolidate せず厳密に復元する。
   */
  checkout(ops: readonly Operation[]): void {
    this.restore(ops);
    this.undoStack = [];
    this.redoStack = [];
  }

  /**
   * キャンバスサイズを変更する。操作ログは保持したまま新サイズで replay し直すため、
   * 全内容は同じ絶対座標を保つ（＝左上基準のキャンバスリサイズ / 拡張・切り詰め）。
   * width/height を変えても不変条件 state === replay(log) は新サイズ基準で成立する。
   */
  resize(width: number, height: number): void {
    this.width = width;
    this.height = height;
    this.restore(this.getLog()); // 現ログを新サイズで再構築
    this.undoStack = [];
    this.redoStack = [];
  }

  /** 永続化された操作ログ + リビジョンを読み込む（リロード復元 / JSON インポート）。 */
  loadProject(p: {
    width?: number;
    height?: number;
    log: readonly Operation[];
    revisions: readonly CommittedRevision[];
  }): void {
    if (typeof p.width === 'number' && typeof p.height === 'number') {
      this.width = p.width;
      this.height = p.height;
    }
    this.checkout(p.log);
    this.revisions = p.revisions.map((r) => ({
      id: r.id,
      label: r.label,
      headIds: [...r.headIds],
      timestamp: r.timestamp,
      ops: [...r.ops],
    }));
  }

  reset(): void {
    this.state = createInitialState(this.width, this.height);
    this.logger.clear();
    this.revisions = [];
    this.undoStack = [];
    this.redoStack = [];
  }
}
