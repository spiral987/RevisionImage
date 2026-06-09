import type { EditorState } from '../types';
import { buffersEqual } from './imageBuffer';

/**
 * 2つの EditorState がビット同一か。レイヤのバッファ・オフセット・可視性・不透明度まで比較。
 * replay の往復一致検証（Phase 2 受け入れ条件）に使用する。
 */
export function statesEqual(a: EditorState, b: EditorState): boolean {
  if (a.width !== b.width || a.height !== b.height) return false;
  if (a.layers.length !== b.layers.length) return false;
  for (let i = 0; i < a.layers.length; i++) {
    const la = a.layers[i];
    const lb = b.layers[i];
    if (la.id !== lb.id) return false;
    if (la.offsetX !== lb.offsetX || la.offsetY !== lb.offsetY) return false;
    if (la.opacity !== lb.opacity || la.visible !== lb.visible) return false;
    if (!buffersEqual(la.buffer, lb.buffer)) return false;
  }
  return true;
}
