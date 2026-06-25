import { describe, it, expect } from 'vitest';
import { EditorSession } from '../src/session';
import { createBrushOp, createAddLayerOp } from '../src/engine/operations';
import { line } from './helpers';

// CanvasEditor のブラシプレビューは「下層(below)/上層(above)の合成」をジェスチャ間でキャッシュし、
// 同じレイヤへ短いストロークを連続して引く間は再 flatten を省く（連続描画の重さ対策）。
// そのキャッシュは「アクティブ層へ描いても、非アクティブな最上位リーフの参照が保たれる」という
// イミュータブル更新の構造共有に依存する。ここではその不変条件を守る（= キャッシュが効き続ける）。
describe('ブラシプレビューキャッシュが依存する構造共有', () => {
  it('アクティブ層への描画は他レイヤの最上位ノード参照を変えない', () => {
    const W = 800;
    const H = 600;
    const session = new EditorSession(W, H);
    const baseId = session.state.activeLayerId;
    session.apply(createAddLayerOp('L1', 'layer 1', W, H));
    session.apply(createAddLayerOp('L2', 'layer 2', W, H));

    // アクティブ＝中間の L1。below=[base], above=[L2]。
    const before = session.state.layers;
    const baseRef = before.find((n) => n.id === baseId)!;
    const l2Ref = before.find((n) => n.id === 'L2')!;

    session.apply(createBrushOp('L1', line(10, 10, 200, 200, 8), { color: [200, 50, 50], size: 6, opacity: 1 }, W, H));

    const after = session.state.layers;
    // 非アクティブ層（base, L2）の参照は不変 → below/above キャッシュがヒットし続ける。
    expect(after.find((n) => n.id === baseId)).toBe(baseRef);
    expect(after.find((n) => n.id === 'L2')).toBe(l2Ref);
    // アクティブ層（L1）は内容が変わったので参照は変わる。
    expect(after.find((n) => n.id === 'L1')).not.toBe(before.find((n) => n.id === 'L1'));
  });

  it('連続して同じレイヤに描いても非アクティブ層の参照は安定し続ける', () => {
    const W = 400;
    const H = 300;
    const session = new EditorSession(W, H);
    const baseId = session.state.activeLayerId;
    session.apply(createAddLayerOp('L1', 'layer 1', W, H));

    const baseRef0 = session.state.layers.find((n) => n.id === baseId)!;
    for (let g = 0; g < 20; g++) {
      session.apply(
        createBrushOp('L1', line(g, g, g + 50, g + 40, 6), { color: [10, 20, 30], size: 4, opacity: 1 }, W, H),
      );
      // 毎ストローク後も below（base 層）の参照は初回と同一。
      expect(session.state.layers.find((n) => n.id === baseId)).toBe(baseRef0);
    }
  });
});
