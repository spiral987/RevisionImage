import type { EditorState, Layer, LayerNode, StrokePoint } from '../src/types';

// statesEqual はエンジン本体に置き（UI の verify でも使うため）、テストはそれを共有する。
export { statesEqual } from '../src/engine/compare';

/**
 * テスト用: レイヤーツリーのノードをリーフ(Layer)として扱う。テストはグループを作らない
 * 前提なので、型の絞り込み（LayerNode → Layer）のためのキャスト。
 */
export const asLayer = (n: LayerNode): Layer => n as Layer;
/** 最上位 i 番目のノードをリーフとして取得。 */
export const leafAt = (state: EditorState, i = 0): Layer => state.layers[i] as Layer;

/** 直線状の点列を生成するテスト用ヘルパ。 */
export function line(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  n = 5,
  pressure = 1,
): StrokePoint[] {
  const pts: StrokePoint[] = [];
  for (let i = 0; i < n; i++) {
    const t = n === 1 ? 0 : i / (n - 1);
    pts.push({ x: x0 + (x1 - x0) * t, y: y0 + (y1 - y0) * t, pressure });
  }
  return pts;
}
