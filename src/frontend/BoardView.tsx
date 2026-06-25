import {
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type MouseEvent as ReactMouseEvent,
} from 'react';
import { useScrollZoom } from './useScrollZoom';
import type { EditorSession } from '../session';
import type { CommittedRevision } from '../backend/revision';
import type { BBox, Operation } from '../types';
import { Replayer } from '../backend/replayer';
import { flattenState } from '../engine/composite';
import { createInitialState } from '../engine/editorState';
import { layoutNodes } from '../backend/filters/layout';
import { bufferToDataURL, THUMB_SCALE } from './thumbnail';
import { ThumbCard, type ThumbCardState } from './ThumbCard';
import { ConfirmButton } from './ConfirmButton';
import { PopoverMenu, type MenuItem } from './Popover';
import { Preview, type PreviewReq } from './Preview';

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
 * 盤面(Board): コミットの木（時間=version の系統）を1枚に表すUI。コミットは全自由配置（ドラッグ）で、
 * クリックでその版へ checkout（＝移動）、ホバーの ⋯ から比較/マージ/削除。
 * 「分岐していること自体が別案（差分）」を木の形で表すので、差分を別途グループ化するUIは持たない。
 */
export function BoardView({
  session,
  version,
  active,
  onEdit,
  onCheckout,
  onCompareRevisions,
  onMergeRevisions,
  onCompareWithCurrent,
  onDeleteRevision,
}: {
  session: EditorSession;
  version: number;
  /** 折りたたみ状態。閉じている間はサムネ合成も木の描画も行わない（描画中のコストを 0 にする）。 */
  active: boolean;
  onEdit: () => void;
  onCheckout: (rev: CommittedRevision) => void;
  onCompareRevisions: (a: CommittedRevision, b: CommittedRevision) => void;
  onMergeRevisions: (trunk: CommittedRevision, branch: CommittedRevision) => void;
  onCompareWithCurrent: (rev: CommittedRevision) => void;
  onDeleteRevision: (rev: CommittedRevision) => void;
}) {
  const deferred = useDeferredValue(version);
  const revisions = session.revisions;
  const log = session.getLog();

  const [commitLabel, setCommitLabel] = useState('');
  const [preview, setPreview] = useState<PreviewReq | null>(null);
  const [pending, setPending] = useState<{ action: 'compare' | 'merge'; from: CommittedRevision } | null>(
    null,
  );

  // 位置は session.boardLayout（中心座標, 永続）に保存。session の直接変更は React に追えないので tick で再描画。
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

    // 各ノードの「親からの変更領域」（差分サムネ用）。親 ops は自分の接頭辞なので slice 以降が新規分。
    const opsLenOf = (id: string) => (id === ROOT ? 0 : (revisions.find((r) => r.id === id)?.ops.length ?? 0));
    const unionFrom = (ops: readonly Operation[], from: number): BBox | null => {
      let x0 = Infinity;
      let y0 = Infinity;
      let x1 = -Infinity;
      let y1 = -Infinity;
      for (let i = from; i < ops.length; i++) {
        const r = ops[i].region;
        if (!r || r.w <= 0 || r.h <= 0) continue;
        x0 = Math.min(x0, r.x);
        y0 = Math.min(y0, r.y);
        x1 = Math.max(x1, r.x + r.w);
        y1 = Math.max(y1, r.y + r.h);
      }
      return x1 > x0 && y1 > y0 ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : null;
    };
    const diffRegion = new Map<string, BBox | null>();
    for (const r of revisions) diffRegion.set(r.id, unionFrom(r.ops, opsLenOf(parentOf.get(r.id)!)));
    if (showWork) diffRegion.set(WORK, unionFrom(log, opsLenOf(workParent)));

    const ids = [ROOT, ...revisions.map((r) => r.id), ...(showWork ? [WORK] : [])];
    const currentId = exact ? exact.id : showWork ? WORK : ROOT;
    return { ids, children, showWork, currentId, diffRegion };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revisions, log.length]);

  // レイアウト（自動）。コミットの初期配置に使う（以後はユーザ配置を優先）。
  const layout = useMemo(() => {
    const input = tree.ids.map((id) => ({ id, children: tree.children.get(id) ?? [] }));
    return layoutNodes(input, { nodeWidth: NODE_W, nodeHeight: NODE_H, rankSep: 60 });
  }, [tree]);

  // 自動レイアウトは「初回配置の種」。新しく現れたノードの座標を一度だけ boardLayout に焼き付ける。
  // 以後コミット追加・削除で木が変わっても dagre 再計算で既存ノードが動かない（getBoardPos 優先）。
  // 種は決定的（自動レイアウト由来）なのでここで永続化（onEdit）はせず、次の編集保存に乗せれば十分。
  useEffect(() => {
    for (const id of tree.ids) {
      if (session.getBoardPos(id)) continue;
      const n = layout.nodes.get(id);
      if (n) session.setBoardPos(id, n.x + PAD, n.y + PAD);
    }
  }, [tree, layout, session]);

  // ---- サムネ生成（差分領域だけを切り出す） ----
  const regionKey = (r: BBox | null | undefined) =>
    r ? `${Math.round(r.x)},${Math.round(r.y)},${Math.round(r.w)},${Math.round(r.h)}` : 'whole';
  const commitThumbRef = useRef(new Map<string, { rk: string; url: string }>());
  const treeThumbs = useMemo(() => {
    // 折りたたみ中は誰も参照しない。全画面 flatten＋縮小（描画中の主コスト）を丸ごと省く。
    // キャッシュ(commitThumbRef)は保持されるので、再展開時は WORK と変更分だけ作り直せばよい。
    if (!active) return new Map<string, string>();
    const cache = commitThumbRef.current;
    const w = session.width;
    const h = session.height;
    const m = new Map<string, string>();
    m.set(ROOT, bufferToDataURL(flattenState(createInitialState(w, h)), THUMB_W, THUMB_H));
    for (const r of revisions) {
      const region = tree.diffRegion.get(r.id) ?? null;
      const rk = regionKey(region);
      const c = cache.get(r.id);
      if (!c || c.rk !== rk) {
        const states = new Replayer(w, h).replayAll(r.ops);
        const url = bufferToDataURL(flattenState(states[r.ops.length]), THUMB_W, THUMB_H, region);
        cache.set(r.id, { rk, url });
      }
      m.set(r.id, cache.get(r.id)!.url);
    }
    const liveIds = new Set(revisions.map((r) => r.id));
    for (const id of [...cache.keys()]) if (!liveIds.has(id)) cache.delete(id);
    if (tree.showWork)
      m.set(WORK, bufferToDataURL(flattenState(session.state), THUMB_W, THUMB_H, tree.diffRegion.get(WORK)));
    return m;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, deferred, revisions, tree]);

  // ---- 位置決定 ----
  const treeCenter = (id: string): Pt => {
    const n = layout.nodes.get(id);
    return n ? { x: n.x + PAD, y: n.y + PAD } : { x: PAD, y: PAD };
  };
  const commitCenter = (id: string): Pt => session.getBoardPos(id) ?? treeCenter(id);

  // ---- ドラッグ（クリックと閾値で区別） ----
  const dragRef = useRef<{ id: string; sx: number; sy: number; bx: number; by: number; moved: boolean } | null>(
    null,
  );
  const suppressRef = useRef<string | null>(null);
  const onDown = (e: ReactPointerEvent, id: string, center: Pt, draggable: boolean) => {
    if (!draggable) return;
    if (pending) return; // 比較/マージの相手選択中はドラッグせずクリック（選択確定）を優先
    const t = e.target as HTMLElement;
    if (t.closest('button, input, .thumb-card-hover, .thumb-card-corner')) return;
    dragRef.current = { id, sx: e.clientX, sy: e.clientY, bx: center.x, by: center.y, moved: false };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };
  const onMove = (e: ReactPointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
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
    } else {
      // 動いていない = タップ（クリック）。.board-card は pointer capture を張るため
      // 合成 click/dblclick がカードに届かないことがある。主操作（checkout 等）はここで
      // 直接発火する。後続で合成 click が来ても onClickCapture が suppressRef で二重発火を防ぐ。
      suppressRef.current = d.id;
      onNodeClick(d.id, revisions.find((r) => r.id === d.id) ?? null, e);
    }
    dragRef.current = null;
  };
  const onClickCapture = (e: ReactMouseEvent, id: string) => {
    if (zHeld) {
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

  // 折りたたみ中は本体を描画しない（27 枚のカード＋SVG の再 reconcile を毎ストローク避ける）。
  // フックは上で全て呼び終えており、ref キャッシュも保持されるので順序・状態は壊れない。
  if (!active) return null;

  // ---- 操作 ----
  const doCommit = () => {
    if (log.length === 0) return;
    session.commitRevision(commitLabel.trim() || `版 ${revisions.length}`);
    setCommitLabel('');
    onEdit();
  };
  const resetLayout = () => {
    session.clearBoardLayout();
    onEdit();
  };
  const onNodeClick = (id: string, rev: CommittedRevision | null, e: ReactMouseEvent) => {
    if (pending) {
      if (rev && rev.id !== pending.from.id) {
        if (pending.action === 'compare') onCompareRevisions(pending.from, rev);
        else onMergeRevisions(pending.from, rev);
      }
      setPending(null);
      return;
    }
    // 通常クリック = その版へ checkout（「クリック＝そこへ行く」）。非破壊なので誤爆コストは無し
    // （未コミット作業は自動保存され、コミット済みは失われない）。今いる場所の再クリックは no-op。
    // 起点/作業中（rev=null）はコミットでないので何もしない。
    if (rev && id !== tree.currentId) onCheckout(rev);
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
  ];

  // ---- 描画用の位置集計（コミット＝点） ----
  let maxX = 300;
  let maxY = 200;
  for (const id of tree.ids) {
    const p = commitCenter(id);
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

  // 原寸プレビュー: 木ノードはその状態を replay。差分領域はサムネと同じ（親からの変更領域）。
  const openTreePreview = (id: string, rev: CommittedRevision | null) => {
    let buffer;
    let title;
    if (id === ROOT) {
      buffer = flattenState(createInitialState(session.width, session.height));
      title = '起点';
    } else if (rev) {
      const st = new Replayer(session.width, session.height).replayAll(rev.ops);
      buffer = flattenState(st[rev.ops.length]);
      title = `#${indexOfRev(rev)} ${rev.label}`;
    } else {
      buffer = flattenState(session.state); // WORK
      title = '現在（作業中）';
    }
    setPreview({ title, buffer, diffRegion: tree.diffRegion.get(id) ?? null });
  };

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
        木＝時間（version の系統）。★=コミット, 青枠=今いる場所。<b>カードをクリックでその版へ Checkout（移動）</b>、
        カードはドラッグで自由配置。ホバーの 🔍 で原寸プレビュー、⋯ から比較 / マージ / 削除。Z＋上下ドラッグでズーム。
        枝分かれ自体が「対等な別案（差分）」を表します。
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
            </svg>

            {/* 時間: コミット/起点/作業カード */}
            {tree.ids.map((id) => {
              const rev = revisions.find((r) => r.id === id) ?? null;
              const c = commitCenter(id);
              const isCurrent = id === tree.currentId;
              const isCommit = !!rev;
              const state: ThumbCardState = isCurrent ? 'current' : isCommit ? 'commit' : 'normal';
              const title = rev ? `#${indexOfRev(rev)} ${rev.label}` : id === ROOT ? '起点' : '現在（作業中）';
              return (
                <div
                  key={id}
                  id={`board-card-${id}`}
                  className="board-card draggable"
                  style={{ left: c.x, top: c.y }}
                  onPointerDown={(e) => {
                    suppressRef.current = null; // 新しい操作の開始。前回のタップ/ドラッグの抑止フラグをクリア
                    onDown(e, id, c, true);
                  }}
                  onPointerMove={onMove}
                  onPointerUp={onUp}
                  onClickCapture={(e) => onClickCapture(e, id)}
                >
                  <ThumbCard
                    thumb={treeThumbs.get(id)}
                    title={title}
                    state={state}
                    size={CARD}
                    className={pending && isCommit && rev?.id !== pending.from.id ? 'pickable' : ''}
                    badge={isCommit ? <span className="revg-star">★</span> : isCurrent ? <span className="revg-now">●</span> : undefined}
                    onActivate={(e) => onNodeClick(id, rev, e)}
                    hoverActions={
                      <>
                        <button className="tc-act" title="原寸プレビュー" onClick={() => openTreePreview(id, rev)}>
                          🔍
                        </button>
                        {isCommit && (
                          <ConfirmButton
                            className="tc-act danger"
                            clicks={3}
                            idleLabel="🗑"
                            armedLabel={(r) => `🗑${r}`}
                            title="このコミットを削除（3 回クリックで実行・警告なし）。作業状態には影響しません。"
                            onConfirm={() => onDeleteRevision(rev!)}
                          />
                        )}
                      </>
                    }
                    cornerMenu={
                      isCommit ? (
                        <PopoverMenu className="revg-card-menu" title="このコミットの操作" items={commitMenu(rev!)} />
                      ) : undefined
                    }
                  />
                </div>
              );
            })}
          </div>
        </div>
      </div>
      {preview && <Preview req={preview} onClose={() => setPreview(null)} />}
    </div>
  );
}
