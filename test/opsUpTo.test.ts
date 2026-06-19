import { describe, it, expect } from 'vitest';
import '../src/engine/operations';
import { EditorSession } from '../src/session';
import { createBrushOp } from '../src/engine/operations';
import { BASE_LAYER_ID } from '../src/engine/editorState';
import { ROOT_ID } from '../src/backend/dag';
import { line } from './helpers';

const W = 64;
const H = 64;
const P = { color: [10, 20, 30] as [number, number, number], size: 3, opacity: 1 };
const dot = (x: number, y: number) => createBrushOp(BASE_LAYER_ID, line(x, y, x, y, 1), P, W, H);

describe('opsUpTo（任意点から分岐するための prefix）', () => {
  it('作業ログ内のノードまでの prefix を返す（その点を含む）', () => {
    const a = dot(1, 1);
    const b = dot(2, 2);
    const c = dot(3, 3);
    const s = new EditorSession(W, H);
    s.checkout([a, b, c]);
    expect(s.opsUpTo(b.id)!.map((o) => o.id)).toEqual([a.id, b.id]);
    expect(s.opsUpTo(c.id)!.map((o) => o.id)).toEqual([a.id, b.id, c.id]);
  });

  it('root は空列、未知 id は null', () => {
    const s = new EditorSession(W, H);
    s.checkout([dot(1, 1)]);
    expect(s.opsUpTo(ROOT_ID)).toEqual([]);
    expect(s.opsUpTo('no-such-op')).toBeNull();
  });

  it('作業ログに無くてもリビジョン側のノードから prefix を取れる', () => {
    const a = dot(1, 1);
    const b = dot(2, 2);
    const s = new EditorSession(W, H);
    s.checkout([a, b]);
    s.commitRevision('v1'); // a,b を確定
    s.checkout([]); // 作業ログを空に（a,b はリビジョンだけが保持）
    expect(s.opsUpTo(a.id)!.map((o) => o.id)).toEqual([a.id]);
  });

  it('checkout(opsUpTo(node)) でその点まで分岐できる', () => {
    const a = dot(1, 1);
    const b = dot(40, 40);
    const c = dot(3, 3);
    const s = new EditorSession(W, H);
    s.checkout([a, b, c]);
    s.checkout(s.opsUpTo(b.id)!);
    expect(s.getLog().map((o) => o.id)).toEqual([a.id, b.id]);
  });
});
