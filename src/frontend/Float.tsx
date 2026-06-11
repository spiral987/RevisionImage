import { useRef, useState } from 'react';
import type { CSSProperties, PointerEvent as ReactPointerEvent, ReactNode } from 'react';

/**
 * 折りたたみ可能なカテゴリ。ヘッダの +/− で開閉する（"+" で展開、"−" で折りたたみ）。
 */
export function Section({
  title,
  children,
  defaultOpen = true,
  right,
}: {
  title: string;
  children: ReactNode;
  defaultOpen?: boolean;
  right?: ReactNode; // ヘッダ右側に置く補助要素（任意）
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className={`fsec ${open ? 'open' : 'closed'}`}>
      <div className="fsec-head">
        <button className="fsec-toggle" onClick={() => setOpen((o) => !o)} title={open ? '折りたたむ' : '展開'}>
          {open ? '−' : '+'}
          <span className="fsec-title">{title}</span>
        </button>
        {right && <div className="fsec-right">{right}</div>}
      </div>
      {open && <div className="fsec-body">{children}</div>}
    </section>
  );
}

/**
 * 半透明のフロートウインドウ。タイトルバーをドラッグで移動、端（右辺/下辺/右下角）をドラッグで
 * リサイズできる。位置・サイズは localStorage に保存する。
 * 初期位置は defaultPos（left/right/top/bottom のいずれか）で指定する。
 */
export function FloatWindow({
  id,
  title,
  defaultPos,
  className,
  children,
}: {
  id: string;
  title: ReactNode;
  defaultPos: Pick<CSSProperties, 'left' | 'right' | 'top' | 'bottom'>;
  className?: string;
  children: ReactNode;
}) {
  const winRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ sx: number; sy: number; left: number; top: number } | null>(null);
  const resizeRef = useRef<{ dir: string; sx: number; sy: number; w: number; h: number } | null>(null);

  const [pos, setPos] = useState<{ left: number; top: number } | null>(() => loadLS(`floatpos:${id}`, 'left', 'top'));
  const [size, setSize] = useState<{ w: number; h: number } | null>(() => loadLS(`floatsize:${id}`, 'w', 'h'));

  // ---- 移動（タイトルバー） ----
  const onDown = (e: ReactPointerEvent) => {
    const rect = winRef.current?.getBoundingClientRect();
    if (!rect) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    dragRef.current = { sx: e.clientX, sy: e.clientY, left: rect.left, top: rect.top };
    setPos({ left: rect.left, top: rect.top });
  };
  const onMove = (e: ReactPointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    setPos({
      left: Math.max(0, Math.min(window.innerWidth - 80, d.left + (e.clientX - d.sx))),
      top: Math.max(0, Math.min(window.innerHeight - 28, d.top + (e.clientY - d.sy))),
    });
  };
  const onUp = () => {
    if (dragRef.current && winRef.current) {
      const r = winRef.current.getBoundingClientRect();
      localStorage.setItem(`floatpos:${id}`, JSON.stringify({ left: r.left, top: r.top }));
    }
    dragRef.current = null;
  };

  // ---- リサイズ（端ハンドル）。開始時に現在の位置・サイズを明示値に固定する ----
  const onResizeDown = (dir: string) => (e: ReactPointerEvent) => {
    e.stopPropagation();
    e.preventDefault();
    const rect = winRef.current?.getBoundingClientRect();
    if (!rect) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    resizeRef.current = { dir, sx: e.clientX, sy: e.clientY, w: rect.width, h: rect.height };
    setPos({ left: rect.left, top: rect.top }); // bottom 基準のウインドウも左上固定にする
    setSize({ w: rect.width, h: rect.height });
  };
  const onResizeMove = (e: ReactPointerEvent) => {
    const r = resizeRef.current;
    if (!r) return;
    let w = r.w;
    let h = r.h;
    if (r.dir.includes('e')) w = r.w + (e.clientX - r.sx);
    if (r.dir.includes('s')) h = r.h + (e.clientY - r.sy);
    setSize({
      w: Math.max(180, Math.min(window.innerWidth - 16, w)),
      h: Math.max(120, Math.min(window.innerHeight - 16, h)),
    });
  };
  const onResizeUp = () => {
    if (resizeRef.current && winRef.current) {
      const r = winRef.current.getBoundingClientRect();
      localStorage.setItem(`floatsize:${id}`, JSON.stringify({ w: r.width, h: r.height }));
    }
    resizeRef.current = null;
  };

  const style: CSSProperties = {
    ...(pos ? { left: pos.left, top: pos.top, right: 'auto', bottom: 'auto' } : { ...defaultPos }),
    ...(size ? { width: size.w, height: size.h } : {}),
  };

  return (
    <div ref={winRef} className={`float-window ${className ?? ''}`} style={style}>
      <div
        className="float-titlebar"
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
      >
        <span className="float-grip">⠿</span>
        {title}
      </div>
      <div className="float-content">{children}</div>
      {(['e', 's', 'se'] as const).map((dir) => (
        <div
          key={dir}
          className={`float-resize float-resize-${dir}`}
          onPointerDown={onResizeDown(dir)}
          onPointerMove={onResizeMove}
          onPointerUp={onResizeUp}
          onPointerCancel={onResizeUp}
        />
      ))}
    </div>
  );
}

function loadLS<A extends string, B extends string>(
  key: string,
  a: A,
  b: B,
): { [K in A | B]: number } | null {
  try {
    const v = JSON.parse(localStorage.getItem(key) || 'null');
    return v && typeof v[a] === 'number' && typeof v[b] === 'number' ? v : null;
  } catch {
    return null;
  }
}
