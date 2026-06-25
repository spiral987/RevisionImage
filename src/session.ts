import type { BoardLayout, Dag, EditorState, LayerNode, Operation } from './types';
import { applyOperation } from './engine/operation';
import { createInitialState } from './engine/editorState';
import { isGroup } from './engine/layer';
import './engine/operations'; // 操作ハンドラを登録
import { createBaselineOp } from './engine/operations';
import { Logger } from './backend/logger';
import { buildDag } from './backend/dagBuilder';
import { ROOT_ID, descendantsOf } from './backend/dag';
import { buildUnifiedDag, computeHeads, type CommittedRevision } from './backend/revision';
import { genId } from './util/id';

/**
 * Undo/Redo の履歴エントリ。log は常に保持し、state は直近のみ参照を保持する
 * （state が null のエントリは log から replay で復元する。メモリと速度のトレードオフ）。
 */
interface HistoryEntry {
  log: Operation[];
  state: EditorState | null;
}

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
  /**
   * 盤面(Board) のカード自由配置（中心座標）。操作ログ・DAG に無関係なサイドカー。
   * キー = コミット id / 起点・作業の予約 id。永続化対象。
   */
  boardLayout: BoardLayout = {};
  width: number;
  height: number;

  /**
   * Undo/Redo はジェスチャ単位の {ログ, 状態} スナップショット列で管理する。
   * 各 apply の「直前」の状態を積む（1 ジェスチャ = 1 スナップショット）。consolidate で
   * 複数ブラシが 1 エントリに統合されても apply 単位で積むため Undo は 1 ジェスチャずつ戻る。
   *
   * state は不変（applyOperation は純関数）なので参照を持つだけで O(1) 復元できる。ただし
   * レイヤバッファを抱えてメモリを食うので、直近 MAX_CACHED_STATES 件だけ state を保持し、
   * 古いエントリは log だけ残して（必要時に）replay で復元する。これで通常の Undo は即時、
   * 深い Undo のみ replay フォールバックになる（旧実装は毎回全ログ replay で、変形を含むと激重だった）。
   */
  private undoStack: HistoryEntry[] = [];
  private redoStack: HistoryEntry[] = [];
  private static readonly MAX_UNDO = 200;
  private static readonly MAX_CACHED_STATES = 24;

  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
    this.state = createInitialState(width, height);
  }

  apply(op: Operation): EditorState {
    this.pushSnapshot(this.undoStack);
    this.redoStack = [];
    this.state = applyOperation(this.state, op);
    this.logger.append(op);
    return this.state;
  }

  /**
   * 複数 op を 1 回の undo 単位として適用する（空なら何もしない）。ユーザの 1 操作が
   * 複数 op に展開されるとき（park/pull 等）に 1 undo へまとめる用途。snapshot を 1 度だけ
   * 積み、各 op を順に逐次適用＋append するので不変条件 state === replay(log) は維持される。
   */
  applyBatch(ops: readonly Operation[]): EditorState {
    if (ops.length === 0) return this.state;
    this.pushSnapshot(this.undoStack);
    this.redoStack = [];
    for (const op of ops) {
      this.state = applyOperation(this.state, op);
      this.logger.append(op);
    }
    return this.state;
  }

  /**
   * 現在の {ログ, 状態} を stack に積む。直近 MAX_CACHED_STATES 件を超えた古いエントリの
   * 状態参照は捨ててバッファ保持を抑える（log は残すので replay で復元可能）。
   */
  private pushSnapshot(stack: HistoryEntry[]): void {
    stack.push({ log: [...this.logger.getLog()], state: this.state });
    const evict = stack.length - 1 - EditorSession.MAX_CACHED_STATES;
    if (evict >= 0 && stack[evict].state) stack[evict].state = null;
    if (stack.length > EditorSession.MAX_UNDO) stack.shift();
  }

  /** スナップショットへ復元する。state があれば O(1)、無ければ log から replay。 */
  private applySnapshot(entry: HistoryEntry): void {
    this.logger.setLog(entry.log);
    if (entry.state) {
      this.state = entry.state;
    } else {
      let s = createInitialState(this.width, this.height);
      for (const op of entry.log) s = applyOperation(s, op);
      this.state = s;
    }
  }

  /**
   * 直前に apply した操作を newOp で置き換え、状態を newState へ直接差し替える。
   * 変形ツールが連続ジェスチャを1操作へ統合する際、全ログ replay を避けて元バッファから
   * 1回だけ再サンプルし直すための軽量経路。
   * 呼び出し側は newState === replay(置換後ログ) を保証すること
   * （applyOperation(ストリーク開始時state, newOp) で計算すれば自動的に満たされる）。
   * undoStack は据え置き（1 ストリーク = 1 undo を保つ）。redoStack は apply 同様クリアする。
   */
  amendLast(newOp: Operation, newState: EditorState): void {
    const log = this.logger.getLog();
    if (log.length === 0) return;
    this.logger.setLog([...log.slice(0, -1), newOp]);
    this.redoStack = [];
    this.state = newState;
  }

  /** ログを ops で置き換え、state を決定的に再構築する（checkout/resize/loadProject 用）。 */
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
    this.pushSnapshot(this.redoStack); // 現在状態を redo 用に退避
    this.applySnapshot(prev);
    return true;
  }

  /** 取り消したジェスチャをやり直す。やり直したら true。 */
  redo(): boolean {
    const next = this.redoStack.pop();
    if (!next) return false;
    this.pushSnapshot(this.undoStack); // 現在状態を undo 用に退避
    this.applySnapshot(next);
    return true;
  }

  getLog(): readonly Operation[] {
    return this.logger.getLog();
  }

  /**
   * バックエンドの規模・負荷指標をまとめて返す（Debug ウィンドウ用）。DAG は構築せず O(総op) で集計する
   * （ノード数 = op数+ROOT。各 op が1ノード）。重い RevG レイアウト等の負荷の当たりを付けるのに使う。
   */
  getStats(): {
    width: number;
    height: number;
    logOps: number;
    dagNodes: number;
    revisions: number;
    revisionOps: number;
    uniqueOps: number;
    boardEntries: number;
    undoDepth: number;
    redoDepth: number;
    layers: number;
    groups: number;
    strokePoints: number;
    opTypeCounts: Record<string, number>;
  } {
    const log = this.getLog();
    const opTypeCounts: Record<string, number> = {};
    let strokePoints = 0;
    const ids = new Set<string>();
    for (const op of log) {
      opTypeCounts[op.type] = (opTypeCounts[op.type] ?? 0) + 1;
      strokePoints += op.strokes?.length ?? 0;
      ids.add(op.id);
    }
    let revisionOps = 0;
    for (const r of this.revisions) {
      revisionOps += r.ops.length;
      for (const op of r.ops) ids.add(op.id); // 共有プレフィックスは同一 id で重複排除
    }
    let layers = 0;
    let groups = 0;
    const walk = (nodes: LayerNode[]) => {
      for (const n of nodes) {
        if (isGroup(n)) {
          groups++;
          walk(n.children);
        } else layers++;
      }
    };
    walk(this.state.layers);
    return {
      width: this.width,
      height: this.height,
      logOps: log.length,
      dagNodes: log.length + 1, // +ROOT
      revisions: this.revisions.length,
      revisionOps,
      uniqueOps: ids.size,
      boardEntries: Object.keys(this.boardLayout).length,
      undoDepth: this.undoStack.length,
      redoDepth: this.redoStack.length,
      layers,
      groups,
      strokePoints,
      opTypeCounts,
    };
  }

  /** 現在のログから DAG（Algorithm 1）を構築する。RevG 可視化(Phase 4)の入力。 */
  getDag(): Dag {
    return buildDag(this.getLog(), this.width, this.height);
  }

  /**
   * 全確定リビジョン + 現在の作業ログを重ね合わせた「統合DAG」を構築する（統合 RevG 用）。
   * リビジョン間の分岐・マージ構造を1つのグラフに表す。共有プレフィックスは畳まれ、
   * 各リビジョンの head が同グラフ上のコミット点になる。
   */
  getUnifiedDag(): Dag {
    const branches = [...this.revisions, { ops: this.getLog() }];
    return buildUnifiedDag(branches, this.width, this.height);
  }

  /**
   * Selective undo で取り除かれる操作 id 集合（プレビュー用・副作用なし）。
   * 指定操作そのもの＋依存DAG上の子孫（=その操作に依存する後続）。作業ログに無い id・root は対象外。
   */
  selectiveUndoTargets(opIds: string | readonly string[]): Set<string> {
    const ids = typeof opIds === 'string' ? [opIds] : opIds;
    const logIds = new Set(this.getLog().map((o) => o.id));
    const dag = this.getDag();
    const drop = new Set<string>();
    for (const id of ids) {
      if (id === ROOT_ID || !logIds.has(id)) continue;
      drop.add(id);
      for (const d of descendantsOf(dag, id)) if (logIds.has(d)) drop.add(d);
    }
    return drop;
  }

  /**
   * Selective undo（NRCI「過去の操作を無かったことにする」）。指定操作とその依存（DAG の子孫）を
   * 作業ログから取り除き、残りを初期状態から決定的に再生する。依存しない後続はそのまま残る。
   * undoStack に積むので 1 回の Undo で即戻せる。ただし undoStack は揮発・有界なので、
   * **恒久的な非破壊性（NRCI は履歴 DAG を消さない）は呼び出し側が事前に commitRevision で担保する**
   * （App.doSelectiveUndo は autoCheckpointIfDirty で取り消し前状態をリビジョン化する。checkout と同方針）。
   * 除去できたら true。
   */
  selectiveUndo(opIds: string | readonly string[]): boolean {
    const drop = this.selectiveUndoTargets(opIds);
    if (drop.size === 0) return false;
    this.pushSnapshot(this.undoStack);
    this.redoStack = [];
    this.restore(this.getLog().filter((op) => !drop.has(op.id)));
    return true;
  }

  /**
   * 指定ノード（op id）までの操作列を、それを含むブランチから切り出す（作業ログ優先→各リビジョン）。
   * RevG の任意点（ノード/エッジ）から新しいブランチを始めるための prefix。
   * root は空列、どのブランチにも無ければ null。これを checkout すればその点から分岐できる。
   */
  opsUpTo(nodeId: string): Operation[] | null {
    if (nodeId === ROOT_ID) return [];
    const branches: readonly Operation[][] = [
      [...this.getLog()],
      ...this.revisions.map((r) => [...r.ops]),
    ];
    for (const ops of branches) {
      const idx = ops.findIndex((o) => o.id === nodeId);
      if (idx >= 0) return ops.slice(0, idx + 1);
    }
    return null;
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
    // 確定後の編集が「コミット済み op」へ consolidate で吸収されないよう確定線を引く
    // （同一 id ⟹ 同一内容 を保ち、merge/統合DAG の共有履歴識別を壊さない）。
    this.logger.freeze();
    return rev;
  }

  /**
   * 確定リビジョン（コミット点）を削除する。リビジョンは保存済みのチェックポイントに過ぎず、
   * **作業ログ・DAG・現在の状態には一切影響しない**（共有ノードは他ブランチ/作業ログが参照する限り
   * 統合DAGに残り、消えるのはそのリビジョン固有のノードとコミットタグ/強制アンカーだけ）。
   * 原論文には無い操作だが、RevG のコミット点が増えすぎたときの整理用に追加した。
   * 削除できたら true。
   */
  deleteRevision(id: string): boolean {
    const before = this.revisions.length;
    this.revisions = this.revisions.filter((r) => r.id !== id);
    delete this.boardLayout[id]; // 盤面の固定座標も後始末（残っても無害だが溜めない）
    return this.revisions.length !== before;
  }

  // ---- 盤面(Board) の自由配置（サイドカー） ----
  getBoardPos(id: string): { x: number; y: number } | undefined {
    return this.boardLayout[id];
  }

  setBoardPos(id: string, x: number, y: number): void {
    this.boardLayout[id] = { x, y };
  }

  /** 自由配置をすべて消す（= 自動整列に戻す）。 */
  clearBoardLayout(): void {
    this.boardLayout = {};
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

  /** 永続化された操作ログ + リビジョン + 空間軸を読み込む（リロード復元 / JSON インポート）。 */
  loadProject(p: {
    width?: number;
    height?: number;
    log: readonly Operation[];
    revisions: readonly CommittedRevision[];
    boardLayout?: BoardLayout;
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
    this.boardLayout = { ...(p.boardLayout ?? {}) };
  }

  /**
   * 履歴を畳む（"flatten / baseline"）。現在の見た目（レイヤーツリー全体）を1つの baseline op に
   * シリアライズしてログを作り直し、過去のログ・revisions・軸・盤面・undo/redo を捨てる。
   * 絵（レイヤー構造・不透明度・表示/非表示・名前・画素）はそのまま残り、履歴だけが消える。
   * restore で state を baseline op から再構築するので不変条件 state === replay(log) を厳守する。
   */
  flattenToBaseline(): void {
    const op = createBaselineOp(this.state, this.width, this.height);
    this.restore([op]); // setLog + 初期状態から replay → state は現在の見た目に一致
    this.revisions = [];
    this.boardLayout = {};
    this.undoStack = [];
    this.redoStack = [];
  }

  /** 完全初期化（白紙）。レイヤーも含め全消去して初期状態へ戻す。 */
  reset(): void {
    this.state = createInitialState(this.width, this.height);
    this.logger.clear();
    this.revisions = [];
    this.boardLayout = {};
    this.undoStack = [];
    this.redoStack = [];
  }
}
