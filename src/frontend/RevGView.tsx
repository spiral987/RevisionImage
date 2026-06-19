import { memo, useEffect, useMemo, useRef, useState } from 'react';
import type { Dag, ImageBuffer, Operation } from '../types';
import type { EditorSession } from '../session';
import type { CommittedRevision } from '../backend/revision';
import { Replayer } from '../backend/replayer';
import { flattenState } from '../engine/composite';
import { createInitialState } from '../engine/editorState';
import { downsampleBuffer } from '../engine/imageBuffer';
import { layoutNodes } from '../backend/filters/layout';
import { buildRevG, type RevGCluster } from '../backend/filters/importance';
import { ROOT_ID } from '../backend/dag';
import { bufferToDataURL, THUMB_SCALE } from './thumbnail';
import { ThumbCard, type ThumbCardState } from './ThumbCard';
import { PopoverMenu, type MenuItem } from './Popover';
import { useScrollZoom } from './useScrollZoom';

const NODE_THUMB = 88; // カードのサムネ表示幅
// 生成解像度＝表示の THUMB_SCALE 倍（高DPI・軽ズームで滲まない）。合成は元々フル解像度なので軽い。
const THUMB_W = Math.round(NODE_THUMB * THUMB_SCALE);
const THUMB_H = Math.round(NODE_THUMB * 0.75 * THUMB_SCALE);
const NODE_W = 104; // レイアウト上のノード占有幅（カード幅＋余白）
const NODE_H = 108;
const PAD = 18;
const IMP_W = 64; // importance 計算用の縮小サイズ
const IMP_H = 48;

function labelOf(op: Operation, memberCount: number): string {
  const p = op.params as Record<string, unknown>;
  let base: string;
  if (op.id === ROOT_ID) base = 'init';
  else if (op.type === 'brightness') base = `bright ${p.delta}`;
  else if (op.type === 'hue') base = `hue ${p.shift}°`;
  else if (op.type === 'translate') base = 'move';
  else if (op.type === 'addLayer') base = String(p.name);
  else base = op.type;
  return memberCount > 1 ? `${base} (+${memberCount - 1})` : base;
}

/** ルート経路の折れ線を角丸の滑らかなパスにする（git グラフ風の曲線エッジ）。 */
function smoothPath(points: { x: number; y: number }[]): string {
  if (points.length === 0) return '';
  if (points.length === 1) return `M ${points[0].x},${points[0].y}`;
  let d = `M ${points[0].x},${points[0].y}`;
  for (let i = 1; i < points.length - 1; i++) {
    const xc = (points[i].x + points[i + 1].x) / 2;
    const yc = (points[i].y + points[i + 1].y) / 2;
    d += ` Q ${points[i].x},${points[i].y} ${xc},${yc}`;
  }
  const last = points[points.length - 1];
  d += ` L ${last.x},${last.y}`;
  return d;
}

export const RevGView = memo(function RevGView({
  session,
  dag,
  revisions,
  version,
  active,
  selectedNodeId,
  onSelectNode,
  onCheckoutRevision,
  onCompareRevisions,
  onMergeRevisions,
  onCompareWithCurrent,
  onDeleteRevision,
  onSelectiveUndo,
  onBranchFrom,
}: {
  session: EditorSession;
  // 統合DAG（全リビジョン + 作業ログを重ねたもの）。
  dag: Dag;
  // 確定リビジョン群。head=コミット点をグラフ上にタグ表示し、強制アンカーにする。
  revisions: CommittedRevision[];
  version: number;
  // 展開中か。false の間も常時マウントしてサムネイルキャッシュを温存するが、
  // 重いグラフ集約(buildRevG)・レイアウト・描画は active のときだけ行う。
  active: boolean;
  selectedNodeId: string | null;
  onSelectNode: (id: string | null) => void;
  // コミットノードのカードメニュー（Quickpose の右クリックメニュー相当）から発行する操作。
  onCheckoutRevision: (rev: CommittedRevision) => void;
  onCompareRevisions: (a: CommittedRevision, b: CommittedRevision) => void;
  onMergeRevisions: (trunk: CommittedRevision, branch: CommittedRevision) => void;
  onCompareWithCurrent: (rev: CommittedRevision) => void;
  onDeleteRevision: (rev: CommittedRevision) => void;
  // selective undo: 作業ログ上の操作（とその依存）を無かったことにする（原論文）。
  onSelectiveUndo: (opIds: string[]) => void;
  // 任意ノード/エッジから新しいブランチを始める（その点までを作業ログにして以後の編集を分岐）。
  onBranchFrom: (nodeId: string) => void;
}) {
  const log = session.getLog();
  const [resolution, setResolution] = useState(1);
  // Z 押下＋ポインタ上下ドラッグでカーソル基準ズーム（Board と共通フック）。
  const { scrollRef, zoom, zHeld, onZoomDownCapture, onZoomMove, onZoomUp, resetZoom } = useScrollZoom();

  // サムネイル(dataURL) と importance 用縮小バッファをノード単位でキャッシュする。
  // 編集で変化するのは末尾ノードだけなので、通常はライブ状態から1枚だけ生成すればよい
  // （全ノード再生成 + 全 dataURL 再デコードが描画直後の固着の原因だった）。
  // op の参照が変われば（consolidate で新オブジェクトになる）再生成する。
  const cacheRef = useRef(new Map<string, { op: Operation | null; thumb: string; small: ImageBuffer }>());
  const sizeKeyRef = useRef('');

  const { thumbs, flatSmall } = useMemo(() => {
    const cache = cacheRef.current;
    const sizeKey = `${session.width}x${session.height}`;
    if (sizeKeyRef.current !== sizeKey) {
      cache.clear(); // キャンバスサイズが変わったらサムネイルを作り直す
      sizeKeyRef.current = sizeKey;
    }

    const gen = (id: string, op: Operation | null, full: ImageBuffer) => {
      cache.set(id, {
        op,
        thumb: bufferToDataURL(full, THUMB_W, THUMB_H),
        small: downsampleBuffer(full, IMP_W, IMP_H),
      });
    };

    if (!cache.has(ROOT_ID)) {
      gen(ROOT_ID, null, flattenState(createInitialState(session.width, session.height)));
    }

    // 1) 作業ログ: ライブ状態からの高速パスを保つ（描画直後の固着対策）。
    const missing = log.filter((op) => {
      const c = cache.get(op.id);
      return !c || c.op !== op;
    });
    if (missing.length > 0) {
      const lastId = log.length ? log[log.length - 1].id : null;
      if (missing.length === 1 && missing[0].id === lastId) {
        // 差分編集: 変わったのは末尾ノードのみ → ライブ状態から生成（replay 不要）。
        gen(lastId!, log[log.length - 1], flattenState(session.state));
      } else {
        // checkout/undo/load 等: 必要な中間状態を replay で得て、欠けたノードだけ生成。
        const states = new Replayer(session.width, session.height).replayAll(log);
        log.forEach((op, i) => {
          const c = cache.get(op.id);
          if (!c || c.op !== op) gen(op.id, op, flattenState(states[i + 1]));
        });
      }
    }

    // 2) 確定リビジョン: まだキャッシュに無い id（=分岐した固有ノード）だけ生成する。
    // 共有プレフィックスは作業ログのパスで生成済み。リビジョン op は凍結なので id 有無で判定でき、
    // 作業ログ側の参照を上書きしない（同一 id のサムネイルは同一プレフィックス＝同一画像）。
    for (const rev of revisions) {
      if (rev.ops.some((op) => !cache.has(op.id))) {
        const states = new Replayer(session.width, session.height).replayAll(rev.ops);
        rev.ops.forEach((op, i) => {
          if (!cache.has(op.id)) gen(op.id, op, flattenState(states[i + 1]));
        });
      }
    }

    // 現在のノード集合（ROOT + 作業ログ + 全リビジョンの op = 統合DAGのノード）以外を掃除。
    const live = new Set<string>([ROOT_ID, ...log.map((o) => o.id)]);
    for (const rev of revisions) for (const op of rev.ops) live.add(op.id);
    for (const id of [...cache.keys()]) if (!live.has(id)) cache.delete(id);

    const thumbsMap = new Map<string, string>();
    const smallMap = new Map<string, ImageBuffer>();
    for (const id of live) {
      const c = cache.get(id);
      if (c) {
        thumbsMap.set(id, c.thumb);
        smallMap.set(id, c.small);
      }
    }
    return { thumbs: thumbsMap, flatSmall: smallMap };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version, revisions, session]);

  // 各リビジョンの head = コミット点。解像度を下げても常にアンカーとして残す。
  const forcedAnchors = useMemo(() => {
    const s = new Set<string>();
    for (const rev of revisions) for (const h of rev.headIds) s.add(h);
    return s;
  }, [revisions]);

  // ノード id → そこに head を持つリビジョンのラベル群（コミット名表示用）。
  // head は強制アンカーなので、必ず自分自身が代表のクラスタになる（クラスタ id == head id）。
  const revTagByNode = useMemo(() => {
    const m = new Map<string, string[]>();
    revisions.forEach((rev, i) => {
      const tag = `#${i} ${rev.label}`;
      for (const h of rev.headIds) m.set(h, [...(m.get(h) ?? []), tag]);
    });
    return m;
  }, [revisions]);

  // ノード id（=コミット点 head）→ リビジョン。同一 head を持つ複数リビジョンは最新を採用。
  const revByHead = useMemo(() => {
    const m = new Map<string, CommittedRevision>();
    for (const rev of revisions) for (const h of rev.headIds) m.set(h, rev);
    return m;
  }, [revisions]);

  // diff/merge の「2つ目を選択」待ち状態（カードクリックで相手を確定）。
  const [pending, setPending] = useState<{ action: 'compare' | 'merge'; from: CommittedRevision } | null>(
    null,
  );

  // Esc で2つ目選択を取消。
  useEffect(() => {
    if (!pending) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setPending(null);
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [pending]);

  // ノードのクリック: 2つ目待ちならその相手として確定、そうでなければ選択トグル。
  const onNodeClick = (nodeId: string) => {
    if (pending) {
      const rev = revByHead.get(nodeId);
      if (rev && rev.id !== pending.from.id) {
        if (pending.action === 'compare') onCompareRevisions(pending.from, rev);
        else onMergeRevisions(pending.from, rev);
      }
      setPending(null); // 相手が非コミット/同一でもピックは終了（キャンセル）
      return;
    }
    onSelectNode(nodeId === selectedNodeId ? null : nodeId);
  };

  const indexOfRev = (rev: CommittedRevision) => revisions.findIndex((r) => r.id === rev.id);

  // コミットカードの ⋯ メニュー（Quickpose の右クリックメニュー相当）。
  const commitMenu = (rev: CommittedRevision): MenuItem[] => [
    { label: 'Checkout（この版へ分岐）', onClick: () => onCheckoutRevision(rev) },
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

  // 集約・レイアウトは展開中のみ計算する（折りたたみ中はサムネイル温存だけでよい）。
  const revg = useMemo(
    () => (active ? buildRevG(dag, flatSmall, resolution, forcedAnchors) : null),
    [active, dag, flatSmall, resolution, forcedAnchors],
  );

  const layout = useMemo(
    () =>
      revg
        ? layoutNodes(revg.clusters.values(), { nodeWidth: NODE_W, nodeHeight: NODE_H, rankSep: 50 })
        : null,
    [revg],
  );

  // 折りたたみ中は何も描画しない（マウントは維持され、上のサムネイル useMemo は走り続ける）。
  if (!active || !revg || !layout) return null;

  const stageW = Math.max(layout.width + PAD * 2, 220);
  const stageH = Math.max(layout.height + PAD * 2, 120);
  const totalNodes = dag.nodes.size;
  // 「現在いる場所」＝作業ログの先頭（末尾 op）。空なら ROOT。
  const currentTipId = log.length ? log[log.length - 1].id : ROOT_ID;
  // 作業ログに属する op id（selective undo の対象になりうるノード）。
  const workingIds = new Set(log.map((o) => o.id));

  return (
    <div className="revg">
      <div className="revg-toolbar">
        <span className="muted">解像度</span>
        <input
          type="range"
          min={0}
          max={1}
          step={0.02}
          value={resolution}
          onChange={(e) => setResolution(Number(e.target.value))}
        />
        <span className="revg-count">
          {revg.clusters.size} / {totalNodes} nodes
        </span>
        <span className="revg-toolbar-spacer" />
        <span className={`keyhint-badge ${zHeld ? 'on' : ''}`} title="Z を押しながら上下ドラッグでズーム">
          Z＝ズーム
        </span>
        <button className="zoom-val" onClick={resetZoom} title="クリックで100%">
          {Math.round(zoom * 100)}%
        </button>
      </div>

      {pending && (
        <div className="revg-pending">
          {pending.action === 'compare' ? '比較' : 'マージ'}する2つ目のコミットを選択（基準:{' '}
          <b>
            #{indexOfRev(pending.from)} {pending.from.label}
          </b>
          ）
          <button onClick={() => setPending(null)}>取消</button>
        </div>
      )}

      <div
        className={`revg-scroll ${zHeld ? 'zooming' : ''}`}
        ref={scrollRef}
        onPointerDownCapture={onZoomDownCapture}
        onPointerMove={onZoomMove}
        onPointerUp={onZoomUp}
        onPointerCancel={onZoomUp}
      >
        <div className="revg-zoom" style={{ width: stageW * zoom, height: stageH * zoom }}>
          <div
            className={`revg-stage ${zHeld ? 'zooming' : ''}`}
            style={{ width: stageW, height: stageH, transform: `scale(${zoom})`, transformOrigin: '0 0' }}
          >
            {/* 背面: 曲線エッジ（クリックはカードに通すため pointer-events none） */}
            <svg
              className="revg-svg"
              width={stageW}
              height={stageH}
              viewBox={`0 0 ${stageW} ${stageH}`}
            >
            <g transform={`translate(${PAD},${PAD})`}>
              {layout.edges.map((e, i) => {
                const d = smoothPath(e.points);
                return (
                  <g key={`${e.from}->${e.to}-${i}`}>
                    <path className="revg-edge" d={d} fill="none" />
                    {/* 透明な太線でクリック判定。上流ノード(from)からブランチを開始。 */}
                    <path
                      className="revg-edge-hit"
                      d={d}
                      fill="none"
                      onClick={() => onBranchFrom(e.from)}
                    >
                      <title>ここから新しいブランチを始める</title>
                    </path>
                  </g>
                );
              })}
            </g>
          </svg>

          {/* 前面: サムネカード（ThumbCard） */}
          {[...revg.clusters.values()].map((cluster: RevGCluster) => {
            const nl = layout.nodes.get(cluster.id);
            if (!nl) return null;
            const rev = revByHead.get(cluster.id);
            const isCommit = !!rev;
            const isTip = cluster.id === currentTipId;
            const selected = cluster.id === selectedNodeId;
            const aggregated = cluster.memberIds.length > 1;
            const title = isCommit
              ? (revTagByNode.get(cluster.id)?.join(' / ') ?? rev!.label)
              : labelOf(cluster.op, cluster.memberIds.length);
            const state: ThumbCardState = selected
              ? 'selected'
              : isTip
                ? 'current'
                : isCommit
                  ? 'commit'
                  : 'normal';
            const badge = isCommit ? (
              <span className="revg-star">★</span>
            ) : isTip ? (
              <span className="revg-now">●</span>
            ) : undefined;
            // カードの ⋯ メニュー: コミット操作 ＋（作業ログ上なら）selective undo。
            const undoTargets = [cluster.id, ...cluster.memberIds].filter((id) => workingIds.has(id));
            const menuItems: MenuItem[] = isCommit ? commitMenu(rev!) : [];
            // 非コミットノードにも「ここから分岐」（コミットは Checkout が同義なので付けない）。
            if (!isCommit && cluster.id !== ROOT_ID) {
              menuItems.push({
                label: 'ここから新しいブランチ',
                title: 'この時点までを作業ログにして、以後の編集を新しい線として分岐する',
                onClick: () => onBranchFrom(cluster.id),
              });
            }
            if (undoTargets.length > 0) {
              menuItems.push({
                label: 'この操作を取り消す（依存も除去）',
                title: 'この操作とそれに依存する後続を作業ログから除去（selective undo）',
                danger: true,
                onClick: () => onSelectiveUndo(undoTargets),
              });
            }
            return (
              <div
                key={cluster.id}
                id={`nrc-node-${cluster.id}`}
                className="revg-card-pos"
                style={{ left: nl.x + PAD, top: nl.y + PAD }}
              >
                <ThumbCard
                  thumb={thumbs.get(cluster.id)}
                  title={title}
                  state={state}
                  size={NODE_THUMB}
                  className={`revg-card ${aggregated ? 'stacked' : ''} ${
                    pending && isCommit ? 'pickable' : ''
                  }`}
                  badge={badge}
                  onActivate={() => onNodeClick(cluster.id)}
                  onDoubleClick={isCommit ? () => onCheckoutRevision(rev!) : undefined}
                  cornerMenu={
                    menuItems.length > 0 ? (
                      <PopoverMenu className="revg-card-menu" title="操作" items={menuItems} />
                    ) : undefined
                  }
                />
              </div>
            );
          })}
          </div>
        </div>
      </div>
    </div>
  );
});
