import { describe, it, expect } from 'vitest';
import '../src/engine/operations';
import { EditorSession } from '../src/session';
import { BASE_LAYER_ID } from '../src/engine/editorState';
import { ROOT_ID } from '../src/backend/dag';
import { createBrushOp } from '../src/engine/operations';
import { line } from './helpers';

const W = 64;
const H = 64;

const RED: [number, number, number] = [255, 0, 0];
const BLUE: [number, number, number] = [0, 0, 255];

function dot(color: [number, number, number], cx: number, cy: number) {
  return createBrushOp(BASE_LAYER_ID, line(cx, cy, cx, cy, 1), { color, size: 20, opacity: 1 }, W, H);
}

describe('リビジョン（コミット点）の削除', () => {
  it('削除しても作業ログ・現在状態は変わらない', () => {
    const s = new EditorSession(W, H);
    const shared = dot(RED, 30, 30);
    s.apply(shared);
    const revA = s.commitRevision('A');
    s.apply(dot(BLUE, 30, 30)); // 作業ログに追記（commit はしない）
    const logBefore = s.getLog().map((o) => o.id);
    const stateBefore = s.state;

    expect(s.deleteRevision(revA.id)).toBe(true);

    expect(s.revisions).toHaveLength(0);
    expect(s.getLog().map((o) => o.id)).toEqual(logBefore); // 作業ログ不変
    expect(s.state).toBe(stateBefore); // 現在状態の参照も不変
  });

  it('存在しない id の削除は false を返し、何も消えない', () => {
    const s = new EditorSession(W, H);
    s.apply(dot(RED, 30, 30));
    s.commitRevision('A');
    expect(s.deleteRevision('does-not-exist')).toBe(false);
    expect(s.revisions).toHaveLength(1);
  });

  it('そのリビジョン固有のノードとコミット点が統合DAGから消える（共有ノードは残る）', () => {
    const s = new EditorSession(W, H);
    const shared = dot(RED, 30, 30);
    s.apply(shared);
    const revA = s.commitRevision('A'); // ops = [shared]

    // revA から分岐して固有 op を1つ積み、別リビジョンとして確定。
    s.checkout(revA.ops);
    const b1 = dot(BLUE, 30, 30); // shared と同領域 → revB 固有の依存ノード
    s.apply(b1);
    const revB = s.commitRevision('B'); // ops = [shared, b1]

    // 作業ログを revA 側へ戻す（b1 は revB だけが持つ固有ノードになる）。
    s.checkout(revA.ops);

    let u = s.getUnifiedDag();
    expect(u.nodes.has(shared.id)).toBe(true);
    expect(u.nodes.has(b1.id)).toBe(true); // revB 由来でまだ存在

    expect(s.deleteRevision(revB.id)).toBe(true);

    u = s.getUnifiedDag();
    expect(u.nodes.has(ROOT_ID)).toBe(true);
    expect(u.nodes.has(shared.id)).toBe(true); // 共有ノードは revA/作業ログが参照 → 残る
    expect(u.nodes.has(b1.id)).toBe(false); // revB 固有ノードは消える
    expect(s.revisions.map((r) => r.id)).toEqual([revA.id]);
  });
});
