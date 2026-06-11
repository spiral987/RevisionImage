import { writePsd, type Layer as PsdLayer, type Psd } from 'ag-psd';
import type { EditorState, ImageBuffer, LayerNode } from '../types';
import { isGroup } from '../engine/layer';
import { flattenState } from '../engine/composite';

/**
 * 現在のレイヤーツリーを PSD（ArrayBuffer）として書き出す。
 * フォルダ＝グループ、各リーフ＝レイヤーとして、表示/不透明度/位置を保持する。
 * PSD は Photoshop と Clip Studio Paint の両方が開けるので、レイヤー構造の受け渡しに使える。
 */

function bufferToCanvas(buf: ImageBuffer): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = buf.width;
  c.height = buf.height;
  const ctx = c.getContext('2d')!;
  const img = ctx.createImageData(buf.width, buf.height);
  img.data.set(buf.data);
  ctx.putImageData(img, 0, 0);
  return c;
}

function nodeToPsd(node: LayerNode): PsdLayer {
  if (isGroup(node)) {
    return {
      name: node.name,
      opened: !node.collapsed,
      hidden: !node.visible,
      opacity: node.opacity,
      // ag-psd の children は「上→下」順。こちらは下→上なので reverse する。
      children: node.children.slice().reverse().map(nodeToPsd),
    };
  }
  return {
    name: node.name,
    canvas: bufferToCanvas(node.buffer),
    left: Math.round(node.offsetX),
    top: Math.round(node.offsetY),
    hidden: !node.visible,
    opacity: node.opacity,
  };
}

export function exportStateToPsd(state: EditorState): ArrayBuffer {
  const psd: Psd = {
    width: state.width,
    height: state.height,
    // 合成プレビュー（ag-psd は自動生成しないので明示的に渡す）。
    canvas: bufferToCanvas(flattenState(state)),
    children: state.layers.slice().reverse().map(nodeToPsd),
  };
  return writePsd(psd);
}
