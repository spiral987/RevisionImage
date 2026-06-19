import {
  useDeferredValue,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type MouseEvent as ReactMouseEvent,
} from 'react';
import { useScrollZoom } from './useScrollZoom';
import type { EditorSession } from '../session';
import type { CommittedRevision } from '../backend/revision';
import type { Operation } from '../types';
import { Replayer } from '../backend/replayer';
import { flattenState } from '../engine/composite';
import { createInitialState, getNode } from '../engine/editorState';
import { cellPreviewState, listGroups } from '../backend/variant';
import { layoutNodes } from '../backend/filters/layout';
import { bufferToDataURL, THUMB_SCALE } from './thumbnail';
import { ThumbCard, type ThumbCardState } from './ThumbCard';
import { PopoverMenu, type MenuItem } from './Popover';

const CARD = 136; // カードのサムネ表示幅
const CARD_H = Math.round(CARD * 0.75);
// 生成解像度＝表示の THUMB_SCALE 倍（高DPI・軽ズームで滲まない）。合成は元々フル解像度なので軽い。
const THUMB_W = Math.round(CARD * THUMB_SCALE);
const THUMB_H = Math.round(CARD_H * THUMB_SCALE);
const NODE_W = 156; // ツリー自動レイアウトのノード占有（カード幅＋余白）
const NODE_H = 168;
const PAD = 28;
const ROOT = '__root__';
const WORK = '__work__';

type Pt = { x: number; y: number };

/** a.ops が b.ops の真の接頭辞か（= a から b へ伸びた履歴）。 */
function isPrefix(a: readonly Operation[], b: readonly Operation[]): boolean {
  if (a.length >= b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i].id !== b[i].id) return false;
  return true;
}
function opsMatchPrefix(prefix: readonly Operation[], log: readonly Operation[]): boolean {
  if (prefix.length > log.length) return false;
  for (let i = 0; i < prefix.length; i++) if (prefix[i].id !== log[i].id) return false;
  return true;
}

/**
 * 盤面(Board): Revisions(時間=コミットの木) と Variants(空間=差分セル) を1枚に統合したUI。
 * 全自由配置: コミットも差分セルも全部ドラッグで動かせる（木は初期配置のみ、以後はユーザ配置を優先）。
 * カード位置は session.boardLayout に永続化（リロードしても保たれる）。
 * 差分セルが過去版由来(sourceRevId)なら、その元コミットへ点線コネクタを引く（時間↔空間の橋）。
 */
export function BoardView({
  session,
  version,
  onEdit,
  onCheckout,
  onCompareRevisions,
  onMergeRevisions,
  onCompareWithCurrent,
  onDeleteRevision,
  onActivateLayer,
}: {
  session: EditorSession;
  version: number;
  onEdit: () => void;
  onCheckout: (rev: CommittedRevision) => void;
  onCompareRevisions: (a: CommittedRevision, b: CommittedRevision) => void;
  onMergeRevisions: (trunk: CommittedRevision, branch: CommittedRevision) => void;
  onCompareWithCurrent: (rev: CommittedRevision) => void;
  onDeleteRevision: (rev: CommittedRevision) => void;
  onActivateLayer: (layerId: string) => void;
}) {
  const deferred = useDeferredValue(version);
  const revisions = session.revisions;
  const log = session.getLog();

  const [commitLabel, setCommitLabel] = useState('');
  const [slotId, setSlotId] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [pending, setPending] = useState<{ action: 'compare' | 'merge'; from: CommittedRevision } | null>(
    null,
  );

  // 位置は session.boardLayout（中心座標, 永続）に保存。seedRef は未配置セルの初期位置（非永続）。
  // session の直接変更は React に追えないので、ドラッグ中は tick で再描画する。
  const seedRef = useRef(new Map<string, Pt>());
  const [, force] = useState(0);
  const tick = () => force((n) => n + 1);

  // ---- コミットの木（= version）を組む。親 = 自分の ops の最長接頭辞コミット。 ----
  const tree = useMemo(() => {
    const exact = revisions.find(
      (r) => r.ops.length === log.length && opsMatchPrefix(r.ops, log) && log.length === r.ops.length,
    );
    const showWork = log.length > 0 && !exact;

    const parentOf = new Map<string, string>();
    for (const r of revisions) {
      let best: CommittedRevision | null = null;
      for (const c of revisions) {
        if (c.id !== r.id && isPrefix(c.ops, r.ops) && (!best || c.ops.length > best.ops.length)) best = c;
      }
      parentOf.set(r.id, best ? best.id : ROOT);
    }
    let workParent = ROOT;
    if (showWork) {
      let best: CommittedRevision | null = null;
      for (const c of revisions) {
        if (opsMatchPrefix(c.ops, log) && (!best || c.ops.length > best.ops.length)) best = c;
      }
      workParent = best ? best.id : ROOT;
    }

    const children = new Map<string, string[]>();
    const addChild = (p: string, c: string) => children.set(p, [...(children.get(p) ?? []), c]);
    for (const r of revisions) addChild(parentOf.get(r.id)!, r.id);
    if (showWork) addChild(workParent, WORK);

    const ids = [ROOT, ...revisions.map((r) => r.id), ...(showWork ? [WORK] : [])];
    // dagre 依存を避け、ここでは layoutNodes を使うため children を渡す。
    const currentId = exact ? exact.id : showWork ? WORK : ROOT;
    return { ids, children, showWork, currentId };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revisions, log.length]);

  // レイアウト（自動）。hybrid のコミット位置・両モードの初期コミット位置に使う。
  const layout = useMemo(() => {
    const input = tree.ids.map((id) => ({ id, children: tree.children.get(id) ?? [] }));
    return layoutNodes(input, { nodeWidth: NODE_W, nodeHeight: NODE_H, rankSep: 60 });
  }, [tree]);

  // ---- サムネ生成 ----
  const commitThumbRef = useRef(new Map<string, string>());
  const treeThumbs = useMemo(() => {
    const cache = commitThumbRef.current;
    const w = session.width;
    const h = session.height;
    const m = new Map<string, string>();
    m.set(ROOT, bufferToDataURL(flattenState(createInitialState(w, h)), THUMB_W, THUMB_H));
    for (const r of revisions) {
      if (!cache.has(r.id)) {
        const states = new Replayer(w, h).replayAll(r.ops);
        cache.set(r.id, bufferToDataURL(flattenState(states[r.ops.length]), THUMB_W, THUMB_H));
      }
      m.set(r.id, cache.get(r.id)!);
    }
    // 凍結コミット以外のキャッシュは掃除。
    const liveIds = new Set(revisions.map((r) => r.id));
    for (const id of [...cache.keys()]) if (!liveIds.has(id)) cache.delete(id);
    if (tree.showWork) m.set(WORK, bufferToDataURL(flattenState(session.state), THUMB_W, THUMB_H));
    return m;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deferred, revisions, tree.showWork]);

  const cellThumbs = useMemo(() => {
    const m = new Map<string, string>();
    for (const axis of session.axes) {
      for (const cell of axis.cells) {
        const st = cellPreviewState(session.state, axis, cell.id);
        m.set(cell.id, bufferToDataURL(flattenState(st), THUMB_W, THUMB_H));
      }
    }
    return m;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deferred]);

  // ---- 位置決定 ----
  const treeCenter = (id: string): Pt => {
    const n = layout.nodes.get(id);
    return n ? { x: n.x + PAD, y: n.y + PAD } : { x: PAD, y: PAD };
  };
  const commitCenter = (id: string): Pt => session.getBoardPos(id) ?? treeCenter(id);

  // 差分セルの初期配置（木の右側に軸ごと積む）。一度決めたら seedRef で安定。
  const treeRight = layout.width + PAD * 2;
  const cellSeed = (axisIdx: number, cellIdx: number, id: string): Pt => {
    const s = seedRef.current.get(id);
    if (s) return s;
    const seed = {
      x: treeRight + 60 + cellIdx * (CARD + 26),
      y: PAD + CARD_H / 2 + axisIdx * (CARD_H + 56),
    };
    seedRef.current.set(id, seed);
    return seed;
  };
  const cellCenter = (id: string, axisIdx: number, cellIdx: number): Pt =>
    session.getBoardPos(id) ?? cellSeed(axisIdx, cellIdx, id);

  // ---- ドラッグ（クリックと閾値で区別） ----
  const dragRef = useRef<{ id: string; sx: number; sy: number; bx: number; by: number; moved: boolean } | null>(
    null,
  );
  const suppressRef = useRef<string | null>(null);
  const onDown = (e: ReactPointerEvent, id: string, center: Pt, draggable: boolean) => {
    if (!draggable) return;
    const t = e.target as HTMLElement;
    if (t.closest('button, input, .thumb-card-hover, .thumb-card-corner')) return;
    dragRef.current = { id, sx: e.clientX, sy: e.clientY, bx: center.x, by: center.y, moved: false };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };
  const onMove = (e: ReactPointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    // 画面上の移動量はズーム倍率で割って盤面座標に直す。
    const dx = (e.clientX - d.sx) / zoomRef.current;
    const dy = (e.clientY - d.sy) / zoomRef.current;
    if (!d.moved && Math.hypot(e.clientX - d.sx, e.clientY - d.sy) < 4) return;
    d.moved = true;
    session.setBoardPos(d.id, d.bx + dx, d.by + dy);
    tick();
  };
  const onUp = (e: ReactPointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    try {
      (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    } catch {
      /* noop */
    }
    if (d.moved) {
      suppressRef.current = d.id;
      onEdit(); // 配置の永続化（autosave をトリガ）
    }
    dragRef.current = null;
  };
  const onClickCapture = (e: ReactMouseEvent, id: string) => {
    if (zHeld) {
      // ズーム操作中のカードクリック（トグル等）を無効化。
      e.stopPropagation();
      e.preventDefault();
      return;
    }
    if (suppressRef.current === id) {
      e.stopPropagation();
      e.preventDefault();
      suppressRef.current = null;
    }
  };

  // ---- ズーム（Z 押下＋ポインタ上下ドラッグ。カーソル位置基準。RevG と共通フック） ----
  const { scrollRef, zoom, zoomRef, zHeld, onZoomDownCapture, onZoomMove, onZoomUp, resetZoom } =
    useScrollZoom();

  // ---- 操作 ----
  const doCommit = () => {
    if (log.length === 0) return;
    session.commitRevision(commitLabel.trim() || `版 ${revisions.length}`);
    setCommitLabel('');
    onEdit();
  };
  const createFromFolder = () => {
    if (!slotId) return;
    const axis = session.addAxis('', slotId);
    session.syncAxisCells(axis.id);
    setSlotId('');
    onEdit();
  };
  const resetLayout = () => {
    session.clearBoardLayout();
    seedRef.current.clear();
    onEdit();
  };
  const onNodeClick = (id: string, rev: CommittedRevision | null) => {
    if (pending) {
      if (rev && rev.id !== pending.from.id) {
        if (pending.action === 'compare') onCompareRevisions(pending.from, rev);
        else onMergeRevisions(pending.from, rev);
      }
      setPending(null);
      return;
    }
    setSelected((s) => (s === id ? null : id));
  };
  const gotoCommit = (revId: string) => {
    setSelected(revId);
    requestAnimationFrame(() =>
      document.getElementById(`board-card-${revId}`)?.scrollIntoView({ block: 'nearest', inline: 'nearest' }),
    );
  };
  const commitMenu = (rev: CommittedRevision): MenuItem[] => [
    { label: 'Checkout（この版へ分岐）', onClick: () => onCheckout(rev) },
    {
      label: 'Compare with…（2つ目を選択）',
      disabled: revisions.length < 2,
      onClick: () => setPending({ action: 'compare', from: rev }),
    },
    {
      label: 'Merge with…（これを trunk に）',
      disabled: revisions.length < 2,
      onClick: () => setPending({ action: 'merge', from: rev }),
    },
    { label: '現在の作業状態と比較', onClick: () => onCompareWithCurrent(rev) },
    { label: 'Delete（このコミットを削除）', danger: true, onClick: () => onDeleteRevision(rev) },
  ];

  // ---- 描画用の位置集計 ----
  const positions = new Map<string, Pt>();
  for (const id of tree.ids) positions.set(id, commitCenter(id));
  session.axes.forEach((axis, ai) =>
    axis.cells.forEach((cell, ci) => positions.set(cell.id, cellCenter(cell.id, ai, ci))),
  );
  let maxX = 300;
  let maxY = 200;
  for (const p of positions.values()) {
    maxX = Math.max(maxX, p.x + CARD);
    maxY = Math.max(maxY, p.y + CARD_H);
  }
  const stageW = maxX + PAD;
  const stageH = maxY + PAD;

  const indexOfRev = (rev: CommittedRevision) => revisions.findIndex((r) => r.id === rev.id);
  const curve = (a: Pt, b: Pt) => {
    const my = (a.y + b.y) / 2;
    return `M ${a.x},${a.y} C ${a.x},${my} ${b.x},${my} ${b.x},${b.y}`;
  };
  const groups = listGroups(session.state);

  return (
    <div className="board">
      <div className="board-toolbar">
        <input
          type="text"
          placeholder="コミットのラベル（任意）"
          value={commitLabel}
          onChange={(e) => setCommitLabel(e.target.value)}
        />
        <button onClick={doCommit} disabled={log.length === 0}>
          Commit
        </button>
        <select value={slotId} onChange={(e) => setSlotId(e.target.value)}>
          <option value="">フォルダから軸…</option>
          {groups.map((g) => (
            <option key={g.id} value={g.id}>
              {'　'.repeat(g.depth)}
              {g.name}
            </option>
          ))}
        </select>
        <button onClick={createFromFolder} disabled={!slotId}>
          軸追加
        </button>
        <span className="board-spacer" />
        <span className={`keyhint-badge ${zHeld ? 'on' : ''}`} title="Z を押しながら盤面を上下ドラッグでズーム">
          Z＋上下ドラッグ＝ズーム
        </span>
        <button className="zoom-val" onClick={resetZoom} title="クリックで100%">
          {Math.round(zoom * 100)}%
        </button>
        <button onClick={resetLayout} title="配置を自動整列に戻す">
          整列に戻す
        </button>
      </div>

      <p className="hint">
        木＝時間（version の系統。★=コミット, 青枠=今いる場所, ダブルクリックで Checkout, ⋯で比較/マージ/削除）。
        カード＝空間（差分セル。クリックで表示トグル）。すべてドラッグで自由配置でき、位置は保存されます。
        Z を押しながら上下ドラッグでズーム。過去版由来のセルは元コミットへ点線でつながります。
      </p>

      {pending && (
        <div className="revg-pending">
          {pending.action === 'compare' ? '比較' : 'マージ'}する2つ目のコミットを選択（基準:{' '}
          <b>
            #{indexOfRev(pending.from)} {pending.from.label}
          </b>
          ）<button onClick={() => setPending(null)}>取消</button>
        </div>
      )}

      <div
        className={`board-scroll ${zHeld ? 'zooming' : ''}`}
        ref={scrollRef}
        onPointerDownCapture={onZoomDownCapture}
        onPointerMove={onZoomMove}
        onPointerUp={onZoomUp}
        onPointerCancel={onZoomUp}
      >
        <div className="board-zoom" style={{ width: stageW * zoom, height: stageH * zoom }}>
          <div
            className="board-stage"
            style={{ width: stageW, height: stageH, transform: `scale(${zoom})`, transformOrigin: '0 0' }}
          >
            <svg className="board-svg" width={stageW} height={stageH} viewBox={`0 0 ${stageW} ${stageH}`}>
            {/* 時間の木のエッジ */}
            {layout.edges.map((e, i) => (
              <path
                key={`t-${e.from}-${e.to}-${i}`}
                className="board-edge"
                d={curve(commitCenter(e.from), commitCenter(e.to))}
                fill="none"
              />
            ))}
            {/* 出自コネクタ（差分セル → 元コミット） */}
            {session.axes.flatMap((axis, ai) =>
              axis.cells.map((cell, ci) => {
                if (!cell.sourceRevId || !positions.has(cell.sourceRevId)) return null;
                return (
                  <path
                    key={`s-${cell.id}`}
                    className="board-srcline"
                    d={curve(cellCenter(cell.id, ai, ci), commitCenter(cell.sourceRevId))}
                    fill="none"
                  />
                );
              }),
            )}
          </svg>

          {/* 時間: コミット/起点/作業カード */}
          {tree.ids.map((id) => {
            const rev = revisions.find((r) => r.id === id) ?? null;
            const c = commitCenter(id);
            const isCurrent = id === tree.currentId;
            const isCommit = !!rev;
            const draggable = true; // 全自由配置: コミット/起点/作業も動かせる
            const state: ThumbCardState = selected === id ? 'selected' : isCurrent ? 'current' : isCommit ? 'commit' : 'normal';
            const title = rev ? `#${indexOfRev(rev)} ${rev.label}` : id === ROOT ? '起点' : '現在（作業中）';
            return (
              <div
                key={id}
                id={`board-card-${id}`}
                className={`board-card ${draggable ? 'draggable' : ''}`}
                style={{ left: c.x, top: c.y }}
                onPointerDown={(e) => onDown(e, id, c, draggable)}
                onPointerMove={onMove}
                onPointerUp={onUp}
                onClickCapture={(e) => onClickCapture(e, id)}
              >
                <ThumbCard
                  thumb={treeThumbs.get(id)}
                  title={title}
                  state={state}
                  size={CARD}
                  badge={isCommit ? <span className="revg-star">★</span> : isCurrent ? <span className="revg-now">●</span> : undefined}
                  onActivate={() => onNodeClick(id, rev)}
                  onDoubleClick={isCommit ? () => onCheckout(rev!) : undefined}
                  cornerMenu={
                    isCommit ? (
                      <PopoverMenu className="revg-card-menu" title="このコミットの操作" items={commitMenu(rev!)} />
                    ) : undefined
                  }
                />
              </div>
            );
          })}

          {/* 空間: 差分セルカード */}
          {session.axes.map((axis, ai) =>
            axis.cells.map((cell, ci) => {
              const node = getNode(session.state, cell.id);
              const dead = !node;
              const on = !!node?.visible;
              const c = cellCenter(cell.id, ai, ci);
              const srcLive = cell.sourceRevId && revisions.some((r) => r.id === cell.sourceRevId);
              return (
                <div
                  key={cell.id}
                  id={`board-card-${cell.id}`}
                  className="board-card draggable"
                  style={{ left: c.x, top: c.y }}
                  onPointerDown={(e) => onDown(e, cell.id, c, true)}
                  onPointerMove={onMove}
                  onPointerUp={onUp}
                  onClickCapture={(e) => onClickCapture(e, cell.id)}
                >
                  <ThumbCard
                    thumb={cellThumbs.get(cell.id)}
                    title={cell.name}
                    state={on ? 'current' : 'normal'}
                    dead={dead}
                    size={CARD}
                    badge={dead ? '⚠' : on ? '☑' : '☐'}
                    hint={ci === 0 ? <span className="board-axis-tag">{axis.name}</span> : undefined}
                    onActivate={() => {
                      session.toggleCell(axis.id, cell.id);
                      onEdit();
                    }}
                    onRename={
                      dead
                        ? undefined
                        : (n) => {
                            session.renameCell(axis.id, cell.id, n);
                            onEdit();
                          }
                    }
                    hoverActions={
                      <>
                        {!dead && (
                          <button
                            className="tc-act"
                            title="このセルを作業対象として編集（pull）"
                            onClick={() => {
                              const leaf = session.pullCellToWorking(axis.id, cell.id);
                              onEdit();
                              if (leaf) onActivateLayer(leaf);
                            }}
                          >
                            ✎
                          </button>
                        )}
                        {srcLive && (
                          <button
                            className="tc-act"
                            title="出自の版へ（時間の木で選択）"
                            onClick={() => gotoCommit(cell.sourceRevId!)}
                          >
                            ⤴
                          </button>
                        )}
                        <button
                          className="tc-act danger"
                          title="このセルを軸から外す（レイヤーは消えません）"
                          onClick={() => {
                            session.removeCell(axis.id, cell.id);
                            onEdit();
                          }}
                        >
                          ✕
                        </button>
                      </>
                    }
                  />
                </div>
              );
            }),
          )}
          </div>
        </div>
      </div>
    </div>
  );
}
