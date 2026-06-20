import { describe, it, expect } from 'vitest';
import '../src/engine/operations';
import { EditorSession } from '../src/session';
import { BASE_LAYER_ID } from '../src/engine/editorState';
import { flattenState } from '../src/engine/composite';
import { mergeDags, buildMergedOps } from '../src/backend/merge';
import { createBrushOp, createAddLayerOp } from '../src/engine/operations';
import { line } from './helpers';

const W = 64;
const H = 64;
const RED: [number, number, number] = [255, 0, 0];
const GREEN: [number, number, number] = [0, 200, 0];
const BLUE: [number, number, number] = [0, 0, 255];
const dot = (color: [number, number, number], x: number, y: number, layer = BASE_LAYER_ID) =>
  createBrushOp(layer, line(x, y, x, y, 1), { color, size: 18, opacity: 1 }, W, H);

const px = (s: EditorSession, x: number, y: number): [number, number, number] => {
  const f = flattenState(s.state);
  const i = (y * f.width + x) * 4;
  return [f.data[i], f.data[i + 1], f.data[i + 2]];
};

describe('Merge 実ワークフロー（session で分岐→commit→merge）', () => {
  it('共通祖先から分岐した2ブランチ（新レイヤー込み・非衝突）を統合すると両方残る', () => {
    const s = new EditorSession(W, H);
    s.apply(dot(RED, 12, 12)); // 共通（base）
    const A = s.commitRevision('A');

    // 分岐 B: A から新レイヤー LB を足して描く
    s.checkout(A.ops);
    s.apply(createAddLayerOp('LB', 'B', W, H));
    s.apply(dot(GREEN, 40, 40, 'LB'));
    const B = s.commitRevision('B');

    // 分岐 C: A から新レイヤー LC を足して別の場所に描く
    s.checkout(A.ops);
    s.apply(createAddLayerOp('LC', 'C', W, H));
    s.apply(dot(BLUE, 50, 10, 'LC'));
    const C = s.commitRevision('C');

    const { conflicts } = mergeDags(B.ops, C.ops, W, H);
    expect(conflicts).toHaveLength(0); // 別レイヤー・別領域＝衝突なし

    const merged = buildMergedOps(B.ops, C.ops, conflicts, new Map());
    s.checkout(merged);
    // 両ブランチの内容が残る
    expect(px(s, 12, 12)).toEqual(RED); // 共通
    expect(px(s, 40, 40)).toEqual(GREEN); // B のレイヤー
    expect(px(s, 50, 10)).toEqual(BLUE); // C のレイヤー
    // 両レイヤーが統合後の文書に存在
    expect(s.state.layers.some((l) => l.id === 'LB')).toBe(true);
    expect(s.state.layers.some((l) => l.id === 'LC')).toBe(true);
  });

  it('同一レイヤ・同一領域で分岐＝衝突。branch-only で branch 側を採用できる', () => {
    const s = new EditorSession(W, H);
    s.apply(dot(RED, 30, 30)); // 共通
    const A = s.commitRevision('A');

    s.checkout(A.ops);
    s.apply(dot(RED, 20, 20)); // trunk 固有（同領域を赤で）
    const B = s.commitRevision('B');

    s.checkout(A.ops);
    s.apply(dot(BLUE, 20, 20)); // branch 固有（同領域を青で）＝衝突
    const C = s.commitRevision('C');

    const { conflicts } = mergeDags(B.ops, C.ops, W, H);
    expect(conflicts).toHaveLength(1);

    // 既定（trunk-only）→ 赤
    s.checkout(buildMergedOps(B.ops, C.ops, conflicts, new Map()));
    expect(px(s, 20, 20)).toEqual(RED);

    // branch-only → 青
    s.checkout(buildMergedOps(B.ops, C.ops, conflicts, new Map([[conflicts[0].id, 'branch-only']])));
    expect(px(s, 20, 20)).toEqual(BLUE);
  });
});
