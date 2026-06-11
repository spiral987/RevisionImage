import { readPsd, type Layer as PsdLayer } from 'ag-psd';
import type { ImageBuffer, Operation } from '../types';
import {
  createAddImageLayerOp,
  createAddGroupOp,
  createMoveNodeOp,
  createSetLayerVisibilityOp,
  createSetLayerOpacityOp,
  createSetGroupCollapsedOp,
  createRemoveLayerOp,
} from '../engine/operations';
import { BASE_LAYER_ID } from '../engine/editorState';
import { createImageBuffer } from '../engine/imageBuffer';
import { genId } from '../util/id';

/**
 * PSD を読み込み、現在のレイヤーツリーを再構築する「操作列(ops)」へ変換する。
 * これを初期状態（Background のみ）から replay するとPSDのツリーが復元される。
 * フォルダ＝グループ、各レイヤー＝addImageLayer、表示/不透明度/折りたたみ/位置を反映。
 *
 * ag-psd の children は「上→下」順。こちらの layers は「下→上」順なので、
 * 各階層を逆順(下から)に emit し、moveNode で親の末尾(=上)へ積むことで順序を一致させる。
 */

function canvasToBuffer(canvas: HTMLCanvasElement): ImageBuffer {
  const ctx = canvas.getContext('2d')!;
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  return { width: canvas.width, height: canvas.height, data: img.data };
}

export async function buildOpsFromPsd(
  file: File,
): Promise<{ width: number; height: number; ops: Operation[] }> {
  const ab = await file.arrayBuffer();
  const psd = readPsd(ab, { skipCompositeImageData: true, skipThumbnail: true });
  const W = psd.width;
  const H = psd.height;
  const ops: Operation[] = [];

  const emit = (node: PsdLayer, parentId: string | null) => {
    const visible = !node.hidden;
    const opacity = typeof node.opacity === 'number' ? node.opacity : 1;
    const name = node.name || (node.children ? 'Folder' : 'Layer');

    if (node.children) {
      // ---- グループ ----
      const gid = genId('group');
      ops.push(createAddGroupOp(gid, name));
      if (parentId !== null) ops.push(createMoveNodeOp(gid, parentId, Number.MAX_SAFE_INTEGER));
      if (node.opened === false) ops.push(createSetGroupCollapsedOp(gid, true));
      if (!visible) ops.push(createSetLayerVisibilityOp(gid, false));
      if (Math.abs(opacity - 1) > 1e-6) ops.push(createSetLayerOpacityOp(gid, opacity));
      for (let i = node.children.length - 1; i >= 0; i--) emit(node.children[i], gid);
    } else {
      // ---- レイヤー（リーフ） ----
      const lid = genId('layer');
      const left = Math.round(node.left ?? 0);
      const top = Math.round(node.top ?? 0);
      const c = node.canvas;
      const buffer =
        c && c.width > 0 && c.height > 0 ? canvasToBuffer(c) : createImageBuffer(W, H);
      const offX = c && c.width > 0 ? left : 0;
      const offY = c && c.height > 0 ? top : 0;
      ops.push(createAddImageLayerOp(lid, name, buffer, offX, offY, W, H));
      if (parentId !== null) ops.push(createMoveNodeOp(lid, parentId, Number.MAX_SAFE_INTEGER));
      if (!visible) ops.push(createSetLayerVisibilityOp(lid, false));
      if (Math.abs(opacity - 1) > 1e-6) ops.push(createSetLayerOpacityOp(lid, opacity));
    }
  };

  const roots = psd.children ?? [];
  for (let i = roots.length - 1; i >= 0; i--) emit(roots[i], null);

  // 既定の Background を削除して PSD のレイヤーだけにする（リーフを1枚以上作った後に置く）。
  if (ops.length > 0) ops.push(createRemoveLayerOp(BASE_LAYER_ID));

  return { width: W, height: H, ops };
}
