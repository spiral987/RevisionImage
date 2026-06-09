import { useEffect, useMemo, useRef, useState } from 'react';
import type { Operation } from '../types';
import type { EditorSession } from '../session';
import type { CommittedRevision } from '../backend/revision';
import { Replayer } from '../backend/replayer';
import { mergeDags, buildMergedOps, type MergeMode } from '../backend/merge';
import { compositeToCanvas } from './render';
import { describeOp } from './opLabel';

const MODES: { value: MergeMode; label: string }[] = [
  { value: 'trunk-only', label: 'trunk only' },
  { value: 'branch-only', label: 'branch only' },
  { value: 'trunk-after-branch', label: 'trunk after branch' },
  { value: 'branch-after-trunk', label: 'branch after trunk' },
];

export function MergeView({
  session,
  trunk,
  branch,
  onMerged,
  onClose,
}: {
  session: EditorSession;
  trunk: CommittedRevision;
  branch: CommittedRevision;
  onMerged: (mergedOps: Operation[], label: string) => void;
  onClose: () => void;
}) {
  const W = session.width;
  const H = session.height;
  const replayer = useMemo(() => new Replayer(W, H), [W, H]);

  const [swapped, setSwapped] = useState(false);
  const tRev = swapped ? branch : trunk;
  const bRev = swapped ? trunk : branch;

  const result = useMemo(
    () => mergeDags(tRev.ops, bRev.ops, W, H),
    [tRev, bRev, W, H],
  );

  const [resolutions, setResolutions] = useState<Map<string, MergeMode>>(new Map());

  // conflicts が変わったら解決をリセット（既定 trunk-only）。
  useEffect(() => {
    setResolutions(new Map());
  }, [result]);

  const mergedOps = useMemo(
    () => buildMergedOps(tRev.ops, bRev.ops, result.conflicts, resolutions),
    [tRev, bRev, result, resolutions],
  );

  const tRef = useRef<HTMLCanvasElement>(null);
  const mRef = useRef<HTMLCanvasElement>(null);
  const bRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    if (tRef.current) compositeToCanvas(tRef.current, replayer.replay(tRev.ops));
    if (bRef.current) compositeToCanvas(bRef.current, replayer.replay(bRev.ops));
  }, [tRev, bRev, replayer]);

  useEffect(() => {
    if (mRef.current) compositeToCanvas(mRef.current, replayer.replay(mergedOps));
  }, [mergedOps, replayer]);

  const setMode = (conflictId: string, mode: MergeMode) => {
    setResolutions((prev) => {
      const next = new Map(prev);
      next.set(conflictId, mode);
      return next;
    });
  };

  const autoCount = bRev.ops.filter(
    (o) => !tRev.ops.some((t) => t.id === o.id) && !result.conflicts.some((c) => c.branchOps.includes(o)),
  ).length;

  return (
    <div className="diff-overlay" onClick={onClose}>
      <div className="diff-modal" onClick={(e) => e.stopPropagation()}>
        <div className="diff-head">
          <h2>
            Merge: <span className="diff-a">{tRev.label}</span> (trunk) ← <span className="diff-b">{bRev.label}</span> (branch)
          </h2>
          <div className="tool-row">
            <button onClick={() => setSwapped((s) => !s)}>trunk⇄branch 入替</button>
            <button onClick={() => onMerged(mergedOps, `merge(${tRev.label}←${bRev.label})`)}>
              この結果を commit
            </button>
            <button onClick={onClose}>✕ 閉じる</button>
          </div>
        </div>

        <p className="hint">
          自動統合: 非衝突の branch 操作 {autoCount} 件を取り込み / 衝突 {result.conflicts.length} 件。
          衝突の既定は trunk only。
        </p>

        <div className="diff-canvases">
          <figure>
            <figcaption className="diff-a">trunk: {tRev.label}</figcaption>
            <canvas ref={tRef} className="diff-canvas" width={W} height={H} />
          </figure>
          <figure>
            <figcaption>merged（プレビュー / {mergedOps.length} ops）</figcaption>
            <canvas ref={mRef} className="diff-canvas" width={W} height={H} />
          </figure>
          <figure>
            <figcaption className="diff-b">branch: {bRev.label}</figcaption>
            <canvas ref={bRef} className="diff-canvas" width={W} height={H} />
          </figure>
        </div>

        <div className="merge-conflicts">
          <h3>Conflicts（{result.conflicts.length}）</h3>
          {result.conflicts.length === 0 ? (
            <p className="hint">衝突はありません。すべて自動統合されました。</p>
          ) : (
            <ul className="conflict-list">
              {result.conflicts.map((c, i) => (
                <li key={c.id}>
                  <div className="conflict-head">
                    衝突 #{i} — 領域 ({Math.round(c.region.x)},{Math.round(c.region.y)} {Math.round(c.region.w)}×
                    {Math.round(c.region.h)})
                  </div>
                  <div className="conflict-ops">
                    <span className="diff-a">trunk: {c.trunkOps.map(describeOp).join(', ')}</span>
                    <span className="diff-b">branch: {c.branchOps.map(describeOp).join(', ')}</span>
                  </div>
                  <div className="tool-row">
                    {MODES.map((m) => (
                      <button
                        key={m.value}
                        className={(resolutions.get(c.id) ?? 'trunk-only') === m.value ? 'active' : ''}
                        onClick={() => setMode(c.id, m.value)}
                      >
                        {m.label}
                      </button>
                    ))}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
