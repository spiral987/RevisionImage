import { useMemo, useState } from 'react';
import type { Dag, ImageBuffer, Operation } from '../types';
import type { EditorSession } from '../session';
import { Replayer } from '../backend/replayer';
import { flattenState } from '../engine/composite';
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

export function RevGView({
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

  // 各 DAG ノードの結果画像から、サムネイル(dataURL)と importance用縮小バッファを一括生成。
  const { thumbs, flatSmall } = useMemo(() => {
    const replayer = new Replayer(session.width, session.height);
    const states = replayer.replayAll(log);
    const thumbsMap = new Map<string, string>();
    const smallMap = new Map<string, ImageBuffer>();
    const add = (id: string, idx: number) => {
      const full = flattenState(states[idx]);
      thumbsMap.set(id, bufferToDataURL(full, THUMB_W, THUMB_H));
      smallMap.set(id, downsampleBuffer(full, IMP_W, IMP_H));
    };
    add(ROOT_ID, 0);
    log.forEach((op, i) => add(op.id, i + 1));
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
}
