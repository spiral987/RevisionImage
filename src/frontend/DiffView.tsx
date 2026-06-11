import { useEffect, useMemo, useRef, useState } from 'react';
import type { Operation } from '../types';
import type { EditorSession } from '../session';
import type { CommittedRevision } from '../backend/revision';
import { Replayer } from '../backend/replayer';
import { diffOps } from '../backend/diff';
import { compositeToCanvas } from './render';
import { describeOp } from './opLabel';

export function DiffView({
  session,
  revA,
  revB,
  onClose,
}: {
  session: EditorSession;
  revA: CommittedRevision;
  revB: CommittedRevision;
  onClose: () => void;
}) {
  const W = session.width;
  const H = session.height;
  const replayer = useMemo(() => new Replayer(W, H), [W, H]);
  const diff = useMemo(() => diffOps(revA.ops, revB.ops), [revA, revB]);

  const aRef = useRef<HTMLCanvasElement>(null);
  const bRef = useRef<HTMLCanvasElement>(null);
  const midRef = useRef<HTMLCanvasElement>(null);

  const [target, setTarget] = useState<'A' | 'B'>('B');
  const targetRev = target === 'A' ? revA : revB;
  const diffCount = targetRev.ops.length - diff.commonPrefix;

  const [step, setStep] = useState(diffCount);
  const [showBBox, setShowBBox] = useState(false);

  // target/リビジョン変更時はステップを末尾（=対象の最終状態）に。
  useEffect(() => {
    setStep(targetRev.ops.length - diff.commonPrefix);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target, revA, revB]);

  // 左右の最終画像。
  useEffect(() => {
    if (aRef.current) compositeToCanvas(aRef.current, replayer.replay(revA.ops));
    if (bRef.current) compositeToCanvas(bRef.current, replayer.replay(revB.ops));
  }, [revA, revB, replayer]);

  // 中央: 共通ベースライン + 対象の差分opを step 個まで適用した中間状態。
  useEffect(() => {
    const c = midRef.current;
    if (!c) return;
    const upTo = diff.commonPrefix + step;
    compositeToCanvas(c, replayer.replay(targetRev.ops, upTo));
    if (showBBox) {
      const ctx = c.getContext('2d');
      if (!ctx) return;
      const drawRects = (ops: Operation[], color: string) => {
        ctx.save();
        ctx.strokeStyle = color;
        ctx.lineWidth = 2;
        ctx.setLineDash([5, 3]);
        for (const op of ops) {
          const r = op.region;
          if (r.w > 0 && r.h > 0) ctx.strokeRect(r.x + 0.5, r.y + 0.5, r.w, r.h);
        }
        ctx.restore();
      };
      drawRects(diff.onlyA, '#eb5757'); // A のみ = 赤
      drawRects(diff.onlyB, '#6fcf97'); // B のみ = 緑
    }
  }, [target, step, showBBox, revA, revB, replayer, diff, targetRev.ops]);

  const noDiff = diff.onlyA.length === 0 && diff.onlyB.length === 0;

  return (
    <div className="diff-overlay" onClick={onClose}>
      <div className="diff-modal" onClick={(e) => e.stopPropagation()}>
        <div className="diff-head">
          <h2>
            Diff: <span className="diff-a">{revA.label}</span> ↔ <span className="diff-b">{revB.label}</span>
          </h2>
          <button onClick={onClose}>✕ 閉じる</button>
        </div>

        <div className="diff-canvases">
          <figure>
            <figcaption className="diff-a">A: {revA.label}（{revA.ops.length} ops）</figcaption>
            <canvas ref={aRef} className="diff-canvas" width={W} height={H} />
          </figure>
          <figure>
            <figcaption>
              中間: 共通{diff.commonPrefix}op + {target}の差分 {step}/{diffCount}
            </figcaption>
            <canvas ref={midRef} className="diff-canvas" width={W} height={H} />
          </figure>
          <figure>
            <figcaption className="diff-b">B: {revB.label}（{revB.ops.length} ops）</figcaption>
            <canvas ref={bRef} className="diff-canvas" width={W} height={H} />
          </figure>
        </div>

        <div className="diff-controls">
          <div className="tool-row">
            <span className="muted">差分を再生:</span>
            <button className={target === 'A' ? 'active' : ''} onClick={() => setTarget('A')}>
              A の差分
            </button>
            <button className={target === 'B' ? 'active' : ''} onClick={() => setTarget('B')}>
              B の差分
            </button>
          </div>
          <input
            type="range"
            min={0}
            max={Math.max(0, diffCount)}
            value={step}
            disabled={diffCount === 0}
            onChange={(e) => setStep(Number(e.target.value))}
          />
          <label className="diff-check">
            <input type="checkbox" checked={showBBox} onChange={(e) => setShowBBox(e.target.checked)} />
            差分領域を表示（A=赤 / B=緑）
          </label>
        </div>

        {noDiff && <p className="hint">この2リビジョンに差分はありません（共通 {diff.common.length} op）。</p>}

        <div className="diff-lists">
          <div>
            <h3>共通 {diff.common.length}</h3>
            <ol className="op-log diff-oplist">
              {diff.common.map((op) => (
                <li key={op.id} className={`op op-${op.klass}`}>
                  <span className="op-type">{op.type}</span>
                  <span className="op-desc">{describeOp(op)}</span>
                </li>
              ))}
            </ol>
          </div>
          <div>
            <h3 className="diff-a">A のみ {diff.onlyA.length}</h3>
            <ol className="op-log diff-oplist">
              {diff.onlyA.map((op) => (
                <li key={op.id} className={`op op-${op.klass}`}>
                  <span className="op-type">{op.type}</span>
                  <span className="op-desc">{describeOp(op)}</span>
                </li>
              ))}
            </ol>
          </div>
          <div>
            <h3 className="diff-b">B のみ {diff.onlyB.length}</h3>
            <ol className="op-log diff-oplist">
              {diff.onlyB.map((op) => (
                <li key={op.id} className={`op op-${op.klass}`}>
                  <span className="op-type">{op.type}</span>
                  <span className="op-desc">{describeOp(op)}</span>
                </li>
              ))}
            </ol>
          </div>
        </div>
      </div>
    </div>
  );
}
