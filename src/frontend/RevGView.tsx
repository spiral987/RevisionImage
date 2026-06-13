import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
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
import { KLASS_COLOR } from './klass';
import { bufferToDataURL } from './thumbnail';

const THUMB_W = 64;
const THUMB_H = 48;
const NODE_W = THUMB_W + 10;
const NODE_H = THUMB_H + 22;
const PAD = 16;
const IMP_W = 64; // importance 計算用の縮小サイズ
const IMP_H = 48;
const MENU_W = 215; // 右クリックメニューの想定サイズ（画面端クランプ用）
const MENU_H = 196;

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
  onDeleteRevision,
}: {
  session: EditorSession;
  // 統合DAG（全リビジョン + 作業ログを重ねたもの）。
  dag: Dag;
  // 確定リビジョン群。head=コミット点をグラフ上にタグ表示し、強制アンカーにする。
  revisions: CommittedRevision[];
  version: number;
  // 展開中か。false の間も常時マウントしてサムネイルキャッシュを温存するが、
  // 重いグラフ集約(buildRevG)・レイアウト・SVG 描画は active のときだけ行う。
  active: boolean;
  selectedNodeId: string | null;
  onSelectNode: (id: string | null) => void;
  // コミットノードの右クリックメニューから発行する操作（原論文 Figure 2 の右クリックメニュー相当）。
  onCheckoutRevision: (rev: CommittedRevision) => void;
  onCompareRevisions: (a: CommittedRevision, b: CommittedRevision) => void;
  onMergeRevisions: (trunk: CommittedRevision, branch: CommittedRevision) => void;
  onDeleteRevision: (rev: CommittedRevision) => void;
}) {
  const log = session.getLog();
  const [resolution, setResolution] = useState(1);

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

  // ノード id → そこに head を持つリビジョンのラベル群（コミットタグ表示用）。
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

  // 右クリックメニュー（コミットノード上）と、diff/merge の「2つ目を選択」待ち状態。
  const [menu, setMenu] = useState<{ x: number; y: number; nodeId: string } | null>(null);
  const [pending, setPending] = useState<{ action: 'compare' | 'merge'; from: CommittedRevision } | null>(
    null,
  );
  // メニューは portal で body 直下に出すため、外側クリック判定は実DOMの contains で行う。
  const menuElRef = useRef<HTMLDivElement>(null);

  // Esc で取消、メニュー外クリックでメニューを閉じる。
  useEffect(() => {
    if (!menu && !pending) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setMenu(null);
        setPending(null);
      }
    };
    const onDocClick = (e: MouseEvent) => {
      if (menuElRef.current?.contains(e.target as Node)) return; // メニュー内クリックは閉じない
      setMenu(null);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('click', onDocClick);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('click', onDocClick);
    };
  }, [menu, pending]);

  // ノードのクリック: 2つ目待ちならその相手として確定、そうでなければ選択トグル。
  const onNodeClick = (nodeId: string) => {
    setMenu(null);
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
  const menuRev = menu ? revByHead.get(menu.nodeId) : null;

  // 集約・レイアウトは展開中のみ計算する（折りたたみ中はサムネイル温存だけでよい）。
  const revg = useMemo(
    () => (active ? buildRevG(dag, flatSmall, resolution, forcedAnchors) : null),
    [active, dag, flatSmall, resolution, forcedAnchors],
  );

  const layout = useMemo(
    () =>
      revg
        ? layoutNodes(revg.clusters.values(), { nodeWidth: NODE_W, nodeHeight: NODE_H, rankSep: 58 })
        : null,
    [revg],
  );

  // 折りたたみ中は何も描画しない（マウントは維持され、上のサムネイル useMemo は走り続ける）。
  if (!active || !revg || !layout) return null;

  const svgW = Math.max(layout.width + PAD * 2, 220);
  const svgH = Math.max(layout.height + PAD * 2, 120);
  const totalNodes = dag.nodes.size;

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

      <div className="revg-scroll">
        <svg className="revg-svg" width={svgW} height={svgH} viewBox={`0 0 ${svgW} ${svgH}`}>
          <g transform={`translate(${PAD},${PAD})`}>
            {layout.edges.map((e, i) => (
              <polyline
                key={`${e.from}->${e.to}-${i}`}
                className="revg-edge"
                points={e.points.map((p) => `${p.x},${p.y}`).join(' ')}
                fill="none"
              />
            ))}

            {[...revg.clusters.values()].map((cluster: RevGCluster) => {
              const nl = layout.nodes.get(cluster.id);
              if (!nl) return null;
              const x = nl.x - nl.width / 2;
              const y = nl.y - nl.height / 2;
              const color = KLASS_COLOR[cluster.op.klass];
              const selected = cluster.id === selectedNodeId;
              const thumb = thumbs.get(cluster.id);
              const aggregated = cluster.memberIds.length > 1;
              const revTags = revTagByNode.get(cluster.id);
              const tagText = revTags?.join(' / ') ?? '';
              const tagW = Math.max(30, tagText.length * 5.6 + 12);
              return (
                <g
                  key={cluster.id}
                  transform={`translate(${x},${y})`}
                  className={`revg-node ${selected ? 'selected' : ''} ${revTags ? 'commit' : ''} ${
                    pending && revTags ? 'pickable' : ''
                  }`}
                  onClick={(e) => {
                    e.stopPropagation();
                    onNodeClick(cluster.id);
                  }}
                  onContextMenu={(e) => {
                    if (revByHead.has(cluster.id)) {
                      e.preventDefault();
                      e.stopPropagation();
                      setPending(null);
                      setMenu({ x: e.clientX, y: e.clientY, nodeId: cluster.id });
                    }
                  }}
                >
                  {aggregated && (
                    <rect
                      className="revg-node-stack"
                      width={nl.width}
                      height={nl.height}
                      rx={6}
                      transform="translate(4,4)"
                      style={{ stroke: color }}
                    />
                  )}
                  {/* コミット点（リビジョン head）は金色のリングで強調する。 */}
                  {revTags && (
                    <rect
                      x={-3}
                      y={-3}
                      width={nl.width + 6}
                      height={nl.height + 6}
                      rx={8}
                      fill="none"
                      stroke="#f2c94c"
                      strokeWidth={1.5}
                      strokeDasharray="4 2"
                    />
                  )}
                  <rect
                    className="revg-node-bg"
                    width={nl.width}
                    height={nl.height}
                    rx={6}
                    style={{ stroke: color, strokeWidth: selected ? 3.5 : aggregated ? 2.5 : 2 }}
                  />
                  {thumb && (
                    <image
                      href={thumb}
                      x={(nl.width - THUMB_W) / 2}
                      y={4}
                      width={THUMB_W}
                      height={THUMB_H}
                      preserveAspectRatio="xMidYMid meet"
                    />
                  )}
                  <text x={nl.width / 2} y={nl.height - 6} textAnchor="middle" className="revg-label">
                    {labelOf(cluster.op, cluster.memberIds.length)}
                  </text>
                  {/* コミットタグ: このノードに head を持つリビジョンのラベル。 */}
                  {revTags && (
                    <g transform={`translate(${nl.width / 2}, -11)`}>
                      <rect x={-tagW / 2} y={-8} width={tagW} height={15} rx={7} fill="#f2c94c" />
                      <text x={0} y={3} textAnchor="middle" className="revg-commit-tag">
                        {tagText}
                      </text>
                    </g>
                  )}
                </g>
              );
            })}
          </g>
        </svg>
      </div>

      {menu &&
        menuRev &&
        // portal で body 直下に描画する。.float-window は backdrop-filter を持つため、その内側だと
        // position:fixed でも包含ブロックがウインドウになり overflow:hidden で切り取られてしまう。
        // さらに画面端で切れないようビューポート内にクランプする。
        createPortal(
          <div
            ref={menuElRef}
            className="revg-menu"
            style={{
              position: 'fixed',
              left: Math.max(8, Math.min(menu.x, window.innerWidth - MENU_W - 8)),
              top: Math.max(8, Math.min(menu.y, window.innerHeight - MENU_H - 8)),
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="revg-menu-head">
              #{indexOfRev(menuRev)} {menuRev.label}
            </div>
            <button
              onClick={() => {
                onCheckoutRevision(menuRev);
                setMenu(null);
              }}
            >
              Checkout（このリビジョンへ分岐）
            </button>
            <button
              disabled={revisions.length < 2}
              onClick={() => {
                setPending({ action: 'compare', from: menuRev });
                setMenu(null);
              }}
            >
              Compare with…（2つ目を選択）
            </button>
            <button
              disabled={revisions.length < 2}
              onClick={() => {
                setPending({ action: 'merge', from: menuRev });
                setMenu(null);
              }}
            >
              Merge with…（これを trunk に）
            </button>
            <div className="revg-menu-sep" />
            <button
              className="revg-menu-danger"
              onClick={() => {
                onDeleteRevision(menuRev);
                setMenu(null);
              }}
            >
              Delete（このコミットを削除）
            </button>
          </div>,
          document.body,
        )}
    </div>
  );
});
