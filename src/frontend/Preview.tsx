import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { BBox, ImageBuffer } from '../types';

export interface PreviewReq {
  title: string;
  /** 表示する合成画像（フル解像度）。 */
  buffer: ImageBuffer;
  /** 「差分」トグルで拡大表示する変更領域（その点の op の region）。無ければトグルを出さない。 */
  diffRegion?: BBox | null;
}

/**
 * ノード/セルの原寸プレビュー。Board/RevG ウインドウ内にオーバーレイ表示する。
 * 一覧（サムネ）は小さく軽いまま保ち、見たい1枚だけここでフル解像度を確認する（detail on demand）。
 * 「全体 ⇄ 差分領域」をトグルでき、差分は変更箇所だけを切り出して拡大（=細部くっきり）。
 * 画像は渡された buffer を canvas へ直接 drawImage するので PNG encode 不要＝軽い。
 */
export function Preview({ req, onClose }: { req: PreviewReq; onClose: () => void }) {
  const hasDiff = !!(req.diffRegion && req.diffRegion.w > 0 && req.diffRegion.h > 0);
  // 既定は「差分」（変更箇所が一目で分かる）。全体は上部トグルで。差分領域が無ければ全体のみ。
  const [mode, setMode] = useState<'whole' | 'diff'>(hasDiff ? 'diff' : 'whole');
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [resizeTick, setResizeTick] = useState(0);

  // 別のノード/セルを開いたら既定（差分があれば差分）に戻す。
  useEffect(() => {
    setMode(hasDiff ? 'diff' : 'whole');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [req]);

  // Esc で閉じる / ウインドウサイズ変化で再描画。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    const onResize = () => setResizeTick((t) => t + 1);
    document.addEventListener('keydown', onKey);
    window.addEventListener('resize', onResize);
    return () => {
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', onResize);
    };
  }, [onClose]);

  useLayoutEffect(() => {
    const wrap = wrapRef.current;
    const cv = canvasRef.current;
    if (!wrap || !cv) return;
    const { buffer } = req;

    // 表示する元矩形（差分モードは region だけ切り出す）。
    let sx = 0;
    let sy = 0;
    let sw = buffer.width;
    let sh = buffer.height;
    if (mode === 'diff' && hasDiff) {
      const r = req.diffRegion!;
      sx = Math.max(0, Math.floor(r.x));
      sy = Math.max(0, Math.floor(r.y));
      sw = Math.max(1, Math.min(buffer.width - sx, Math.ceil(r.w)));
      sh = Math.max(1, Math.min(buffer.height - sy, Math.ceil(r.h)));
    }

    // 合成画像をオフスクリーンへ。
    const off = document.createElement('canvas');
    off.width = buffer.width;
    off.height = buffer.height;
    const octx = off.getContext('2d');
    if (!octx) return;
    const imgData = octx.createImageData(buffer.width, buffer.height);
    imgData.data.set(buffer.data);
    octx.putImageData(imgData, 0, 0);

    // 利用可能領域へ contain。DPR 倍のバッキングで描画して滲みを抑える。
    const availW = Math.max(1, wrap.clientWidth - 20);
    const availH = Math.max(1, wrap.clientHeight - 20);
    const scale = Math.min(availW / sw, availH / sh);
    const dispW = Math.max(1, Math.round(sw * scale));
    const dispH = Math.max(1, Math.round(sh * scale));
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    cv.width = Math.round(dispW * dpr);
    cv.height = Math.round(dispH * dpr);
    cv.style.width = `${dispW}px`;
    cv.style.height = `${dispH}px`;
    const ctx = cv.getContext('2d');
    if (!ctx) return;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(off, sx, sy, sw, sh, 0, 0, cv.width, cv.height);
  }, [req, mode, hasDiff, resizeTick]);

  return (
    <div
      className="node-preview"
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="np-bar">
        <span className="np-title">{req.title}</span>
        {hasDiff && (
          <div className="np-toggle">
            <button className={mode === 'whole' ? 'on' : ''} onClick={() => setMode('whole')}>
              全体
            </button>
            <button className={mode === 'diff' ? 'on' : ''} onClick={() => setMode('diff')}>
              差分
            </button>
          </div>
        )}
        <button className="np-close" onClick={onClose} title="閉じる（Esc）">
          ✕
        </button>
      </div>
      <div className="np-body" ref={wrapRef}>
        <canvas ref={canvasRef} />
      </div>
    </div>
  );
}
