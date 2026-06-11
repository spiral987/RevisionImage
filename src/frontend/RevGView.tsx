import { memo, useMemo, useRef, useState } from 'react';
import type { Dag, ImageBuffer, Operation } from '../types';
import type { EditorSession } from '../session';
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
  version,
  selectedNodeId,
  onSelectNode,
}: {
  session: EditorSession;
  dag: Dag;
  version: number;
  selectedNodeId: string | null;
  onSelectNode: (id: string | null) => void;
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
    const t0 = performance.now();
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

    // 現在のノード集合（ROOT + log）以外のキャッシュを掃除する。
    const live = new Set<string>([ROOT_ID, ...log.map((o) => o.id)]);
    for (const id of [...cache.keys()]) if (!live.has(id)) cache.delete(id);

    const thumbsMap = new Map<string, string>();
    const smallMap = new Map<string, ImageBuffer>();
    for (const id of live) {
      const c = cache.get(id)!;
      thumbsMap.set(id, c.thumb);
      smallMap.set(id, c.small);
    }
    // 診断: サムネイル生成が重い時だけ出力（通常は無音。不要になったら削除可）。
    const dt = performance.now() - t0;
    if (dt > 8) {
      // eslint-disable-next-line no-console
      console.info(`[perf] RevG thumbs ${dt.toFixed(1)}ms (nodes=${live.size}, regen=${missing.length})`);
    }
    return { thumbs: thumbsMap, flatSmall: smallMap };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version, session]);

  const revg = useMemo(
    () => buildRevG(dag, flatSmall, resolution),
    [dag, flatSmall, resolution],
  );

  const layout = useMemo(
    () => layoutNodes(revg.clusters.values(), { nodeWidth: NODE_W, nodeHeight: NODE_H }),
    [revg],
  );

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
              return (
                <g
                  key={cluster.id}
                  transform={`translate(${x},${y})`}
                  className={`revg-node ${selected ? 'selected' : ''}`}
                  onClick={() => onSelectNode(selected ? null : cluster.id)}
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
                </g>
              );
            })}
          </g>
        </svg>
      </div>
    </div>
  );
});
