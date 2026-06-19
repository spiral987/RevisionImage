import type { Dag, EditorState, Operation, VariantAxis, VariantCell } from './types';
import { applyOperation } from './engine/operation';
import { createInitialState, getNode } from './engine/editorState';
import { isGroup, firstLeafId } from './engine/layer';
import './engine/operations'; // 操作ハンドラを登録
import {
  createAddImageLayerOp,
  createMoveNodeOp,
  createSetLayerVisibilityOp,
} from './engine/operations';
import { Logger } from './backend/logger';
import { buildDag } from './backend/dagBuilder';
import {
  buildUnifiedDag,
  computeHeads,
  revisionPiece,
  type CommittedRevision,
} from './backend/revision';
import { selectionOps, slotChildren, slotPiece } from './backend/variant';
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
   * 空間軸（差分制作 / Variants）。CONCEPT §3.1 の空間エッジを、操作ログ・DAG とは別の
   * サイドカーとして保持する（操作依存グラフの不変条件に触れない）。永続化対象。
   */
  axes: VariantAxis[] = [];
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
   * 確定リビジョン（コミット点）を削除する。リビジョンは保存済みのチェックポイントに過ぎず、
   * **作業ログ・DAG・現在の状態には一切影響しない**（共有ノードは他ブランチ/作業ログが参照する限り
   * 統合DAGに残り、消えるのはそのリビジョン固有のノードとコミットタグ/強制アンカーだけ）。
   * 原論文には無い操作だが、RevG のコミット点が増えすぎたときの整理用に追加した。
   * 削除できたら true。
   */
  deleteRevision(id: string): boolean {
    const before = this.revisions.length;
    this.revisions = this.revisions.filter((r) => r.id !== id);
    return this.revisions.length !== before;
  }

  // ---- 空間軸（差分制作 / Variants） ---------------------------------------
  // CONCEPT §3.1 / §3.4。データモデルのみ（UI は別フェーズ）。

  /** 差し替え点(slotId)に対する空間軸を新規作成する。cells は空で始まる。 */
  addAxis(name: string, slotId: string): VariantAxis {
    const axis: VariantAxis = {
      id: genId('axis'),
      name: name && name.trim() ? name.trim() : `軸 ${this.axes.length + 1}`,
      slotId,
      cells: [],
    };
    this.axes.push(axis);
    return axis;
  }

  /**
   * 任意の場所のレイヤー群から「選択式(slotless)」の軸を作る（フォルダ不要）。CONCEPT §3.1。
   * 差し替え点フォルダを持たず、与えた layer をそのまま別案セルにする。レイヤーツリーは変更せず、
   * 「これらは対等な別案だ」という読み（可視のトグル）を被せるだけ。存在するノードのみ採用する。
   */
  addAxisFromLayers(name: string, layerIds: readonly string[]): VariantAxis {
    const axis: VariantAxis = {
      id: genId('axis'),
      name: name && name.trim() ? name.trim() : `軸 ${this.axes.length + 1}`,
      cells: [],
    };
    for (const id of layerIds) {
      const node = getNode(this.state, id);
      if (node && !axis.cells.some((c) => c.id === id)) axis.cells.push({ id, name: node.name });
    }
    this.axes.push(axis);
    return axis;
  }

  /** 軸を削除する（レイヤー実体・作業状態には触れない。読み方を消すだけ）。 */
  removeAxis(axisId: string): boolean {
    const before = this.axes.length;
    this.axes = this.axes.filter((a) => a.id !== axisId);
    return this.axes.length !== before;
  }

  getAxis(axisId: string): VariantAxis | undefined {
    return this.axes.find((a) => a.id === axisId);
  }

  /** 軸名を変更する（サイドカーの注釈のみ。レイヤー実体・replay には無関係）。空文字は無視。 */
  renameAxis(axisId: string, name: string): boolean {
    const axis = this.getAxis(axisId);
    const next = name.trim();
    if (!axis || !next || axis.name === next) return false;
    axis.name = next;
    return true;
  }

  /** セル名を変更する（サイドカーの注釈のみ）。空文字は無視。 */
  renameCell(axisId: string, cellId: string, name: string): boolean {
    const axis = this.getAxis(axisId);
    const next = name.trim();
    if (!axis || !next) return false;
    const cell = axis.cells.find((c) => c.id === cellId);
    if (!cell || cell.name === next) return false;
    cell.name = next;
    return true;
  }

  /** 軸にセルを登録する。cell.id（= slot 配下の兄弟 nodeId）が既出なら冪等に無視。 */
  addCell(axisId: string, cell: VariantCell): boolean {
    const axis = this.getAxis(axisId);
    if (!axis || axis.cells.some((c) => c.id === cell.id)) return false;
    axis.cells.push({ id: cell.id, name: cell.name, sourceRevId: cell.sourceRevId });
    return true;
  }

  /**
   * 軸のセルを slot グループの現在の直下の子と同期する（差分制作のオーサリング導線）。
   * slot 直下にあって未登録の子をセルに追加し、もう slot 直下に無いセルを除去する。
   * 既存セルの順序・名前・sourceRevId は保つ。変化があれば true。
   */
  syncAxisCells(axisId: string): boolean {
    const axis = this.getAxis(axisId);
    if (!axis || !axis.slotId) return false; // 選択式(slotless)は同期対象のフォルダを持たない
    const children = slotChildren(this.state, axis.slotId);
    const childIds = new Set(children.map((c) => c.id));
    let changed = false;
    for (const c of children) {
      if (!axis.cells.some((x) => x.id === c.id)) {
        axis.cells.push({ id: c.id, name: c.name });
        changed = true;
      }
    }
    const kept = axis.cells.filter((x) => childIds.has(x.id));
    if (kept.length !== axis.cells.length) {
      axis.cells = kept;
      changed = true;
    }
    return changed;
  }

  removeCell(axisId: string, cellId: string): boolean {
    const axis = this.getAxis(axisId);
    if (!axis) return false;
    const before = axis.cells.length;
    axis.cells = axis.cells.filter((c) => c.id !== cellId);
    return axis.cells.length !== before;
  }

  /** 軸内のセル順を変更する（行列UIでの並べ替え用）。 */
  reorderCell(axisId: string, cellId: string, toIndex: number): boolean {
    const axis = this.getAxis(axisId);
    if (!axis) return false;
    const from = axis.cells.findIndex((c) => c.id === cellId);
    if (from < 0) return false;
    const to = Math.max(0, Math.min(axis.cells.length - 1, toIndex));
    if (from === to) return false;
    const cells = [...axis.cells];
    const [moved] = cells.splice(from, 1);
    cells.splice(to, 0, moved);
    axis.cells = cells;
    return true;
  }

  /**
   * 軸のセルをトグル（表示/非表示を反転）する。可視が変わったら表示 op を適用して true。
   * 選択は表示 op としてログに残るので replay/commit 整合（差分切替が版に焼ける）。
   */
  toggleCell(axisId: string, cellId: string): boolean {
    const axis = this.getAxis(axisId);
    if (!axis) return false;
    const ops = selectionOps(axis, this.state, cellId);
    if (ops.length === 0) return false;
    this.applyBatch(ops);
    return true;
  }

  /**
   * 過去のコミット(リビジョン)をこの軸の別案セルとして取り込む（時間→空間の昇格, CONCEPT §3.3）。
   * リビジョンの内容ピースを slot フォルダ内の新レイヤーとして配置し、セルに登録する
   * （sourceRevId に出自を保持＝時間の読みとの橋）。取り込んだセルは初期は非表示にして現在の
   * 合成を乱さない（Variants でトグルしてプレビュー/採用する）。成功で true。
   */
  addRevisionAsCell(axisId: string, rev: CommittedRevision): boolean {
    const axis = this.getAxis(axisId);
    if (!axis) return false;
    if (axis.slotId) {
      const slot = getNode(this.state, axis.slotId);
      if (!slot || !isGroup(slot)) return false; // フォルダ式: slot はフォルダのみ
    }
    const piece = revisionPiece(rev, this.width, this.height);
    if (!piece) return false; // 何も描かれていない版
    const layerId = genId('layer');
    const ops: Operation[] = [
      createAddImageLayerOp(layerId, rev.label, piece.buffer, piece.x, piece.y, this.width, this.height),
    ];
    // フォルダ式は slot フォルダ末尾へ。選択式(slotless)は最上位のまま（addImageLayer の既定位置）。
    if (axis.slotId) ops.push(createMoveNodeOp(layerId, axis.slotId, 1e9));
    ops.push(createSetLayerVisibilityOp(layerId, false)); // 初期は非表示
    this.applyBatch(ops);
    this.addCell(axisId, { id: layerId, name: rev.label, sourceRevId: rev.id });
    return true;
  }

  /**
   * park（退避, CONCEPT §3.4）: 現在の slot の見た目を 1 枚のスナップショットに焼いて
   * 新しい別案セルとして構造へ送り、作業ビューをクリアする（＝作業スタックが軽くなる）。
   * 非破壊: 元の子は削除せず非表示にするだけ。退避セルも初期は非表示で、Variants でトグルすれば
   * いつでも引き戻せる（pull）。slot に見えるものが無ければ false。
   */
  parkSlot(axisId: string): boolean {
    const axis = this.getAxis(axisId);
    if (!axis || !axis.slotId) return false; // フォルダ式のみ（選択式は退避対象の領域を持たない）
    const slotId = axis.slotId;
    const slot = getNode(this.state, slotId);
    if (!slot || !isGroup(slot)) return false;
    const piece = slotPiece(this.state, slotId);
    if (!piece) return false; // 見えているものが無い
    const layerId = genId('layer');
    const name = `退避 ${axis.cells.length + 1}`;
    const ops: Operation[] = [];
    // 現在見えている slot 直下の子を非表示にして作業ビューを空にする（非破壊）。
    for (const child of slot.children) {
      if (child.visible) ops.push(createSetLayerVisibilityOp(child.id, false));
    }
    // 焼いたスナップショットを slot 内の隠しレイヤーとして足す。
    ops.push(
      createAddImageLayerOp(layerId, name, piece.buffer, piece.x, piece.y, this.width, this.height),
    );
    ops.push(createMoveNodeOp(layerId, slotId, 1e9));
    ops.push(createSetLayerVisibilityOp(layerId, false));
    this.applyBatch(ops);
    this.addCell(axisId, { id: layerId, name });
    return true;
  }

  /**
   * pull（引き出し, CONCEPT §3.4）: 空間のセルを時間軸の作業対象として引き出す。セルを可視にし、
   * 編集対象にすべきリーフ layer の id を返す（セルがフォルダなら最初のリーフ）。UI 側はこの id を
   * CanvasEditor のアクティブレイヤーに設定する。セルが無ければ null。
   */
  pullCellToWorking(axisId: string, cellId: string): string | null {
    const axis = this.getAxis(axisId);
    if (!axis || !axis.cells.some((c) => c.id === cellId)) return null;
    const node = getNode(this.state, cellId);
    if (!node) return null;
    const leaf = isGroup(node) ? firstLeafId([node]) ?? null : node.id;
    if (!node.visible) this.apply(createSetLayerVisibilityOp(cellId, true));
    return leaf;
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
    axes?: readonly VariantAxis[];
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
    this.axes = (p.axes ?? []).map((a) => ({
      id: a.id,
      name: a.name,
      slotId: a.slotId,
      cells: a.cells.map((c) => ({ id: c.id, name: c.name, sourceRevId: c.sourceRevId })),
    }));
  }

  reset(): void {
    this.state = createInitialState(this.width, this.height);
    this.logger.clear();
    this.revisions = [];
    this.axes = [];
    this.undoStack = [];
    this.redoStack = [];
  }
}
