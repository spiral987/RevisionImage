import type { BBox, Layer, LayerGroup, LayerNode } from '../types';
import { createImageBuffer, cloneImageBuffer } from './imageBuffer';

export function createLayer(id: string, name: string, width: number, height: number): Layer {
  return {
    id,
    name,
    buffer: createImageBuffer(width, height),
    offsetX: 0,
    offsetY: 0,
    visible: true,
    opacity: 1,
  };
}

/** ノードがフォルダ(LayerGroup)か（リーフ Layer との型ガード）。 */
export function isGroup(node: LayerNode): node is LayerGroup {
  return 'children' in node;
}

export function createGroup(id: string, name: string): LayerGroup {
  return { id, name, visible: true, opacity: 1, collapsed: false, children: [] };
}

/** ノード以下の全リーフ(Layer)の id を集める。 */
export function collectLeafIds(node: LayerNode): string[] {
  if (!isGroup(node)) return [node.id];
  return node.children.flatMap(collectLeafIds);
}

/** ノード自身と全子孫の id を集める（グループ含む。サイクル検出に使う）。 */
export function collectNodeIds(node: LayerNode): string[] {
  if (!isGroup(node)) return [node.id];
  return [node.id, ...node.children.flatMap(collectNodeIds)];
}

/** ノード配列内の最初のリーフ id（active 付け替えのフォールバック用）。 */
export function firstLeafId(nodes: LayerNode[]): string | undefined {
  for (const n of nodes) {
    const ids = collectLeafIds(n);
    if (ids.length) return ids[0];
  }
  return undefined;
}

/**
 * レイヤを複製する。既定ではバッファも複製する（ピクセルを書き換える操作向け）。
 * バッファを変更しない操作（translate 等）では cloneBuffer:false で共有してよい
 * （バッファは「書く前に必ず複製」という規約のもとで不変として扱う）。
 */
export function cloneLayer(layer: Layer, opts?: { cloneBuffer?: boolean }): Layer {
  return {
    ...layer,
    buffer: opts?.cloneBuffer === false ? layer.buffer : cloneImageBuffer(layer.buffer),
  };
}

/**
 * レイヤの内容（不透明ピクセル）の bounding box をキャンバス座標で返す。
 * 内容が無ければ空 bbox {0,0,0,0}。color/translate 操作の「影響範囲」(region) 算出に使う
 * （原論文の領域ベース依存判定を全面近似なしで成立させるため）。
 */
export function layerContentBBox(layer: Layer): BBox {
  const { buffer, offsetX, offsetY } = layer;
  const { width: w, height: h, data } = buffer;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (data[(y * w + x) * 4 + 3] !== 0) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < minX) return { x: 0, y: 0, w: 0, h: 0 };
  return { x: minX + offsetX, y: minY + offsetY, w: maxX - minX + 1, h: maxY - minY + 1 };
}
