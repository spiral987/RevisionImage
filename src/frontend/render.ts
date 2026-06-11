import type { EditorState } from '../types';
import { flattenState } from '../engine/composite';

/**
 * EditorState を純TSの flattenState で1枚に合成し、キャンバスへ putImageData する。
 * 表示ピクセルが replay/サムネイルの flatten 結果と完全一致するよう、合成は1経路に統一する。
 */
export function compositeToCanvas(canvas: HTMLCanvasElement, state: EditorState): void {
  if (canvas.width !== state.width) canvas.width = state.width;
  if (canvas.height !== state.height) canvas.height = state.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const flat = flattenState(state);
  const img = ctx.createImageData(flat.width, flat.height);
  img.data.set(flat.data);
  ctx.putImageData(img, 0, 0);
}
