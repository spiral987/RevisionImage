import type { EditorState, ImageBuffer, Layer, LayerNode } from '../types';
import { createImageBuffer } from './imageBuffer';
import { isGroup } from './layer';

export interface FlattenOptions {
  /** 背景色 RGBA(0..255)。既定は不透明白（エディタ表示と一致）。 */
  background?: [number, number, number, number];
}

/**
 * EditorState を1枚の RGBA バッファに合成する（純TS, DOM非依存）。
 * 背景の上にレイヤを下から順に source-over 合成する。
 * DOM の canvas を使わないため Node でも動作し、replay のピクセル一致検証や
 * サムネイル生成（Phase 4）に使える。UI 表示もこの結果を putImageData する。
 */
export function flattenState(state: EditorState, opts?: FlattenOptions): ImageBuffer {
  const out = createImageBuffer(state.width, state.height);
  const [br, bg, bb, ba] = opts?.background ?? [255, 255, 255, 255];
  const d = out.data;
  for (let i = 0; i < d.length; i += 4) {
    d[i] = br;
    d[i + 1] = bg;
    d[i + 2] = bb;
    d[i + 3] = ba;
  }
  compositeNodes(out, state.layers, state.width, state.height);
  return out;
}

/**
 * レイヤーツリーを下から順に out に合成する（再帰）。
 * フォルダ(group)は子を独立した透明バッファに合成してから、group 全体の opacity で out に重ねる
 * （フォルダの不透明度/表示がまとめて効く＝isolation）。
 */
function compositeNodes(out: ImageBuffer, nodes: LayerNode[], width: number, height: number): void {
  for (const node of nodes) {
    if (!node.visible || node.opacity <= 0) continue;
    if (isGroup(node)) {
      const groupBuf = createImageBuffer(width, height);
      compositeNodes(groupBuf, node.children, width, height);
      compositeLayer(out, {
        id: node.id,
        name: node.name,
        buffer: groupBuf,
        offsetX: 0,
        offsetY: 0,
        visible: true,
        opacity: node.opacity,
      });
    } else {
      compositeLayer(out, node);
    }
  }
}

/** 1レイヤを offset 位置・opacity 込みで out に source-over 合成する。 */
export function compositeLayer(out: ImageBuffer, layer: Layer): void {
  const { buffer, opacity } = layer;
  // オフセットは設計上整数だが、非整数だと宛先インデックスが非整数になり代入が
  // サイレントに無視され、レイヤが消える。防御的に丸めて整数化する。
  const offsetX = Math.round(layer.offsetX);
  const offsetY = Math.round(layer.offsetY);
  const ow = out.width;
  const oh = out.height;
  const bw = buffer.width;
  const bh = buffer.height;
  const od = out.data;
  const sd = buffer.data;
  for (let y = 0; y < bh; y++) {
    const oy = y + offsetY;
    if (oy < 0 || oy >= oh) continue;
    for (let x = 0; x < bw; x++) {
      const ox = x + offsetX;
      if (ox < 0 || ox >= ow) continue;
      const si = (y * bw + x) * 4;
      const sa = (sd[si + 3] / 255) * opacity;
      if (sa <= 0) continue;
      const oi = (oy * ow + ox) * 4;
      const da = od[oi + 3] / 255;
      const outA = sa + da * (1 - sa);
      if (outA <= 0) {
        od[oi] = 0;
        od[oi + 1] = 0;
        od[oi + 2] = 0;
        od[oi + 3] = 0;
        continue;
      }
      const sr = sd[si] / 255;
      const sg = sd[si + 1] / 255;
      const sb = sd[si + 2] / 255;
      const dr = od[oi] / 255;
      const dg = od[oi + 1] / 255;
      const db = od[oi + 2] / 255;
      od[oi] = Math.round(((sr * sa + dr * da * (1 - sa)) / outA) * 255);
      od[oi + 1] = Math.round(((sg * sa + dg * da * (1 - sa)) / outA) * 255);
      od[oi + 2] = Math.round(((sb * sa + db * da * (1 - sa)) / outA) * 255);
      od[oi + 3] = Math.round(outA * 255);
    }
  }
}
