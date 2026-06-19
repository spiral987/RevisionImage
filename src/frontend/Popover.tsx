import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

export interface MenuItem {
  label: string;
  onClick: () => void;
  /** 破壊的操作（削除など）は赤系で表示。 */
  danger?: boolean;
  disabled?: boolean;
  /** トグル項目: true ならチェック表示。 */
  checked?: boolean;
  title?: string;
}

const MENU_W = 200;
const GAP = 4;

/**
 * 「⋯」トリガで開く小さなドロップダウン。稀な操作をカード/ヘッダから畳むための共通部品。
 * FloatWindow は overflow:hidden + backdrop-filter を持ち内側だと切れるため、メニューは
 * body 直下に portal してビューポート内へクランプする（RevGView のメニューと同じ方式）。
 */
export function PopoverMenu({
  items,
  label = '⋯',
  title = 'メニュー',
  className = '',
}: {
  items: MenuItem[];
  label?: string;
  title?: string;
  className?: string;
}) {
  const btnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  // ボタン位置からメニュー位置を決め、画面端でクランプする。
  useLayoutEffect(() => {
    if (!open || !btnRef.current) return;
    const r = btnRef.current.getBoundingClientRect();
    const h = menuRef.current?.offsetHeight ?? items.length * 30 + 8;
    let top = r.bottom + GAP;
    if (top + h > window.innerHeight - 8) top = Math.max(8, r.top - GAP - h); // 下が溢れるなら上に開く
    const left = Math.max(8, Math.min(r.right - MENU_W, window.innerWidth - MENU_W - 8));
    setPos({ left, top });
  }, [open, items.length]);

  // 外側クリック / Esc で閉じる。
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (menuRef.current?.contains(e.target as Node)) return;
      if (btnRef.current?.contains(e.target as Node)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <>
      <button
        ref={btnRef}
        className={`popover-trigger ${className}`}
        title={title}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((o) => !o);
        }}
      >
        {label}
      </button>
      {open &&
        pos &&
        createPortal(
          <div
            ref={menuRef}
            className="popover-menu"
            style={{ position: 'fixed', left: pos.left, top: pos.top, width: MENU_W }}
            onClick={(e) => e.stopPropagation()}
          >
            {items.map((it, i) => (
              <button
                key={i}
                className={`popover-item ${it.danger ? 'danger' : ''}`}
                disabled={it.disabled}
                title={it.title}
                onClick={() => {
                  it.onClick();
                  setOpen(false);
                }}
              >
                <span className="popover-check">{it.checked ? '✓' : ''}</span>
                {it.label}
              </button>
            ))}
          </div>,
          document.body,
        )}
    </>
  );
}
