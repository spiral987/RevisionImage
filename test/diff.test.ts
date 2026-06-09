import { describe, it, expect } from 'vitest';
import '../src/engine/operations';
import { EditorSession } from '../src/session';
import { BASE_LAYER_ID } from '../src/engine/editorState';
import { diffOps } from '../src/backend/diff';
import { createBrushOp } from '../src/engine/operations';
import { line } from './helpers';

const W = 64;
const H = 64;
const P = { color: [0, 0, 0] as [number, number, number], size: 6, opacity: 1 };
const brush = (x0: number, y0: number, x1: number, y1: number) =>
  createBrushOp(BASE_LAYER_ID, line(x0, y0, x1, y1, 3), P, W, H);

describe('Revision diff（id=ラベル一致）', () => {
  it('prefix リビジョン: 共通=短い方、差分=追加分', () => {
    const a = [brush(2, 2, 10, 10), brush(20, 20, 30, 30)];
    const b = [...a, brush(40, 40, 50, 50)]; // a に1op追加
    const d = diffOps(a, b);
    expect(d.common.map((o) => o.id)).toEqual(a.map((o) => o.id));
    expect(d.onlyA).toHaveLength(0);
    expect(d.onlyB).toHaveLength(1);
    expect(d.onlyB[0].id).toBe(b[2].id);
    expect(d.commonPrefix).toBe(2);
  });

  it('分岐リビジョン: 共通プレフィックス後にそれぞれ固有op', () => {
    const shared = [brush(2, 2, 10, 10)];
    const a = [...shared, brush(20, 20, 25, 25)];
    const b = [...shared, brush(40, 40, 45, 45), brush(50, 50, 55, 55)];
    const d = diffOps(a, b);
    expect(d.common.map((o) => o.id)).toEqual(shared.map((o) => o.id));
    expect(d.onlyA.map((o) => o.id)).toEqual([a[1].id]);
    expect(d.onlyB.map((o) => o.id)).toEqual([b[1].id, b[2].id]);
    expect(d.commonPrefix).toBe(1);
  });

  it('同一リビジョン: 差分なし', () => {
    const a = [brush(2, 2, 10, 10), brush(20, 20, 30, 30)];
    const d = diffOps(a, a);
    expect(d.onlyA).toHaveLength(0);
    expect(d.onlyB).toHaveLength(0);
    expect(d.common).toHaveLength(2);
    expect(d.commonPrefix).toBe(2);
  });

  it('session.commitRevision は操作列スナップショットを凍結する', () => {
    const s = new EditorSession(W, H);
    s.apply(brush(2, 2, 10, 10));
    const r1 = s.commitRevision('first');
    expect(r1.ops).toHaveLength(1);
    // 追加編集しても確定済みリビジョンは変化しない（色違い=統合されない別op）
    s.apply(createBrushOp(BASE_LAYER_ID, line(40, 40, 50, 50, 3), { ...P, color: [255, 0, 0] }, W, H));
    const r2 = s.commitRevision('second');
    expect(r1.ops).toHaveLength(1);
    expect(r2.ops).toHaveLength(2);

    const d = diffOps(r1.ops, r2.ops);
    expect(d.common).toHaveLength(1);
    expect(d.onlyB).toHaveLength(1);
    expect(s.revisions).toHaveLength(2);
  });

  it('reset でリビジョンもクリアされる', () => {
    const s = new EditorSession(W, H);
    s.apply(brush(2, 2, 10, 10));
    s.commitRevision();
    s.reset();
    expect(s.revisions).toHaveLength(0);
  });
});
