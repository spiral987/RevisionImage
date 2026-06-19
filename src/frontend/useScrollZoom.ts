import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from 'react';

const ZOOM_MIN = 0.2;
const ZOOM_MAX = 4;

/**
 * スクロール領域に scale を掛ける方式のズーム（Z 押下＋ポインタ上下ドラッグ、カーソル位置基準）。
 * Board / RevG のように「.scroll > .stage に transform: scale」する UI で共有する。
 * Canvas は別系統（transform-pan + zoomToAnchor）なのでこのフックは使わない。
 *
 * 使い方:
 *  - 返り値 scrollRef を overflow:auto のコンテナに、onZoom* をそのコンテナに付ける。
 *  - コンテナ内に「scale(zoom) する stage」と、それを内包する「stageW*zoom サイズの wrapper」を置く。
 *  - zHeld の間はカードのクリック/ドラッグを抑止する（pointer-events:none 等）。
 */
export function useScrollZoom() {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [zoom, setZoom] = useState(1);
  const zoomRef = useRef(1);
  zoomRef.current = zoom;
  const [zHeld, setZHeld] = useState(false);
  const dragRef = useRef<{ startY: number; z0: number; px: number; py: number; ax: number; ay: number } | null>(
    null,
  );
  const pendingScrollRef = useRef<{ left: number; top: number } | null>(null);

  // Z 押下中だけズームモード（入力欄フォーカス中・Ctrl/⌘併用時は無効）。
  useEffect(() => {
    const isField = (t: EventTarget | null) => {
      const el = t as HTMLElement | null;
      return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);
    };
    const down = (e: KeyboardEvent) => {
      if ((e.key === 'z' || e.key === 'Z') && !e.ctrlKey && !e.metaKey && !isField(e.target)) setZHeld(true);
    };
    const up = (e: KeyboardEvent) => {
      if (e.key === 'z' || e.key === 'Z') setZHeld(false);
    };
    const blur = () => setZHeld(false);
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    window.addEventListener('blur', blur);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
      window.removeEventListener('blur', blur);
    };
  }, []);

  // ズーム後、カーソル下の点が動かないようスクロール位置を補正する（描画後に適用）。
  useLayoutEffect(() => {
    const sc = scrollRef.current;
    const p = pendingScrollRef.current;
    if (sc && p) {
      sc.scrollLeft = p.left;
      sc.scrollTop = p.top;
      pendingScrollRef.current = null;
    }
  }, [zoom]);

  const onZoomDownCapture = (e: ReactPointerEvent) => {
    if (!zHeld) return; // 通常時はカードのクリック/ドラッグ等に通す
    const sc = scrollRef.current;
    if (!sc) return;
    e.preventDefault();
    e.stopPropagation();
    const rect = sc.getBoundingClientRect();
    const ax = e.clientX - rect.left;
    const ay = e.clientY - rect.top;
    const z0 = zoomRef.current;
    dragRef.current = {
      startY: e.clientY,
      z0,
      px: (sc.scrollLeft + ax) / z0, // カーソル下のステージ座標
      py: (sc.scrollTop + ay) / z0,
      ax,
      ay,
    };
    sc.setPointerCapture?.(e.pointerId);
  };
  const onZoomMove = (e: ReactPointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    const z1 = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, d.z0 * Math.pow(1.01, d.startY - e.clientY)));
    pendingScrollRef.current = { left: d.px * z1 - d.ax, top: d.py * z1 - d.ay };
    setZoom(z1);
  };
  const onZoomUp = (e: ReactPointerEvent) => {
    if (!dragRef.current) return;
    try {
      scrollRef.current?.releasePointerCapture?.(e.pointerId);
    } catch {
      /* noop */
    }
    dragRef.current = null;
  };
  const resetZoom = () => setZoom(1);

  return { scrollRef, zoom, zoomRef, zHeld, onZoomDownCapture, onZoomMove, onZoomUp, resetZoom };
}
