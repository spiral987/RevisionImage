import type { ImageBuffer } from '../types';

/** 透明(全0)な RGBA バッファを生成。 */
export function createImageBuffer(width: number, height: number): ImageBuffer {
  return { width, height, data: new Uint8ClampedArray(width * height * 4) };
}

export function cloneImageBuffer(buf: ImageBuffer): ImageBuffer {
  return { width: buf.width, height: buf.height, data: new Uint8ClampedArray(buf.data) };
}

/**
 * src の矩形 (x,y,w,h) を切り出した新しいバッファを返す（範囲外は透明）。
 * リビジョンの確定画像から「内容の bbox」だけを素材ピースとして取り出すのに使う。
 */
export function cropBuffer(src: ImageBuffer, x: number, y: number, w: number, h: number): ImageBuffer {
  const out = createImageBuffer(w, h);
  const sd = src.data;
  const od = out.data;
  for (let yy = 0; yy < h; yy++) {
    const sy = y + yy;
    if (sy < 0 || sy >= src.height) continue;
    for (let xx = 0; xx < w; xx++) {
      const sx = x + xx;
      if (sx < 0 || sx >= src.width) continue;
      const si = (sy * src.width + sx) * 4;
      const di = (yy * w + xx) * 4;
      od[di] = sd[si];
      od[di + 1] = sd[si + 1];
      od[di + 2] = sd[si + 2];
      od[di + 3] = sd[si + 3];
    }
  }
  return out;
}

/** 2つのバッファがビット同一か（決定性検証に使用）。 */
export function buffersEqual(a: ImageBuffer, b: ImageBuffer): boolean {
  if (a.width !== b.width || a.height !== b.height) return false;
  const da = a.data;
  const db = b.data;
  if (da.length !== db.length) return false;
  for (let i = 0; i < da.length; i++) {
    if (da[i] !== db[i]) return false;
  }
  return true;
}

/**
 * source-over アルファ合成で1ピクセルを描く。
 * color 各チャネルは 0..255、a（ソースアルファ）は 0..1。
 * 浮動小数演算は同一入力 → 同一出力（決定的）。最終値は Math.round で整数化してから
 * 代入するため、Uint8ClampedArray 側の丸め（偶数丸め）による曖昧さは生じない。
 */
export function blendPixel(
  buf: ImageBuffer,
  x: number,
  y: number,
  r: number,
  g: number,
  b: number,
  a: number,
): void {
  if (a <= 0) return;
  if (x < 0 || y < 0 || x >= buf.width || y >= buf.height) return;
  const idx = (y * buf.width + x) * 4;
  const d = buf.data;
  const sa = a;
  const dr = d[idx] / 255;
  const dg = d[idx + 1] / 255;
  const dbb = d[idx + 2] / 255;
  const da = d[idx + 3] / 255;
  const outA = sa + da * (1 - sa);
  if (outA <= 0) {
    d[idx] = 0;
    d[idx + 1] = 0;
    d[idx + 2] = 0;
    d[idx + 3] = 0;
    return;
  }
  const sr = r / 255;
  const sg = g / 255;
  const sb = b / 255;
  const outR = (sr * sa + dr * da * (1 - sa)) / outA;
  const outG = (sg * sa + dg * da * (1 - sa)) / outA;
  const outB = (sb * sa + dbb * da * (1 - sa)) / outA;
  d[idx] = Math.round(outR * 255);
  d[idx + 1] = Math.round(outG * 255);
  d[idx + 2] = Math.round(outB * 255);
  d[idx + 3] = Math.round(outA * 255);
}

/** 最近傍で縮小（純TS）。visual importance のピクセル差分を安価に計算するため。 */
export function downsampleBuffer(buf: ImageBuffer, tw: number, th: number): ImageBuffer {
  const out = createImageBuffer(tw, th);
  for (let y = 0; y < th; y++) {
    const sy = Math.min(buf.height - 1, Math.floor((y * buf.height) / th));
    for (let x = 0; x < tw; x++) {
      const sx = Math.min(buf.width - 1, Math.floor((x * buf.width) / tw));
      const si = (sy * buf.width + sx) * 4;
      const di = (y * tw + x) * 4;
      out.data[di] = buf.data[si];
      out.data[di + 1] = buf.data[si + 1];
      out.data[di + 2] = buf.data[si + 2];
      out.data[di + 3] = buf.data[si + 3];
    }
  }
  return out;
}

export interface GrownBuffer {
  buffer: ImageBuffer;
  offsetX: number;
  offsetY: number;
}

/**
 * 非破壊レイヤ移動(translate=offset)のもとで、ブラシがキャンバス全面に描けるようにする。
 * 与えられたレイヤローカル領域 [lxMin,lxMax]×[lyMin,lyMax] を内包するよう、必要なら
 * バッファを拡張した「新しい(コピーされた)バッファ」と調整後オフセットを返す。
 *
 * オフセットは「バッファローカル(lx,ly) を キャンバス(lx+offset) に表示する」関係。
 * 左/上に拡張するとバッファローカル原点がずれるため、既存内容のキャンバス位置を保つよう
 * offset を offset+newMin で補正する。拡張不要でも常にコピーを返す（純関数のため）。
 *
 * 決定性: 入力(現バッファ・offset・領域)が同じなら拡張結果も同一 → replay で同一バッファに再構築される。
 */
export function growBufferToInclude(
  buffer: ImageBuffer,
  offsetX: number,
  offsetY: number,
  lxMin: number,
  lyMin: number,
  lxMax: number,
  lyMax: number,
): GrownBuffer {
  const newMinX = Math.min(0, Math.floor(lxMin));
  const newMinY = Math.min(0, Math.floor(lyMin));
  const newMaxX = Math.max(buffer.width, Math.ceil(lxMax));
  const newMaxY = Math.max(buffer.height, Math.ceil(lyMax));
  const newW = newMaxX - newMinX;
  const newH = newMaxY - newMinY;

  if (newMinX === 0 && newMinY === 0 && newW === buffer.width && newH === buffer.height) {
    return { buffer: cloneImageBuffer(buffer), offsetX, offsetY };
  }

  const out = createImageBuffer(newW, newH);
  const shiftX = -newMinX;
  const shiftY = -newMinY;
  const sd = buffer.data;
  const od = out.data;
  const bw = buffer.width;
  const bh = buffer.height;
  for (let y = 0; y < bh; y++) {
    const si = y * bw * 4;
    const oi = ((y + shiftY) * newW + shiftX) * 4;
    od.set(sd.subarray(si, si + bw * 4), oi);
  }
  return { buffer: out, offsetX: offsetX + newMinX, offsetY: offsetY + newMinY };
}

/**
 * RGBA バッファを base64 文字列へ。画像レイヤ操作(addImageLayer)が画素を op に保持し、
 * JSON 永続化・replay で決定的に再構築できるようにするためのエンコード（純TS）。
 * btoa/atob は browser・Node(18+) 双方で利用可能なグローバル。
 */
export function bufferToBase64(buf: ImageBuffer): string {
  const d = buf.data;
  let bin = '';
  const CHUNK = 0x8000; // call-stack 制限回避のため分割
  for (let i = 0; i < d.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, d.subarray(i, i + CHUNK) as unknown as number[]);
  }
  return btoa(bin);
}

/** base64 文字列を width×height の RGBA バッファへ復元する（bufferToBase64 の逆）。 */
export function base64ToBuffer(b64: string, width: number, height: number): ImageBuffer {
  const bin = atob(b64);
  const data = new Uint8ClampedArray(width * height * 4);
  const n = Math.min(data.length, bin.length);
  for (let i = 0; i < n; i++) data[i] = bin.charCodeAt(i);
  return { width, height, data };
}

/** destination-out（消しゴム）: アルファを係数 (1-a) で減衰させる。RGBは変えない。 */
export function erasePixel(buf: ImageBuffer, x: number, y: number, a: number): void {
  if (a <= 0) return;
  if (x < 0 || y < 0 || x >= buf.width || y >= buf.height) return;
  const idx = (y * buf.width + x) * 4;
  const d = buf.data;
  const da = d[idx + 3] / 255;
  d[idx + 3] = Math.round(da * (1 - a) * 255);
}
