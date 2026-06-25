import { useEffect, useRef, useState } from 'react';

/**
 * 破壊的操作を「数回クリックさせて」誤爆を防ぐボタン。
 * clicks 回（既定3）クリックで onConfirm。途中で resetMs ミリ秒放置すると idle に戻る。
 * armed 中は confirm-arming クラスが付くので CSS で警告色にできる。
 */
export function ConfirmButton({
  clicks = 3,
  onConfirm,
  idleLabel,
  armedLabel,
  title,
  resetMs = 2200,
  className,
  disabled,
}: {
  clicks?: number;
  onConfirm: () => void;
  idleLabel: string;
  /** armed 中のラベル。remaining = あと何回で実行か。 */
  armedLabel?: (remaining: number) => string;
  title?: string;
  resetMs?: number;
  className?: string;
  disabled?: boolean;
}) {
  const [armed, setArmed] = useState(0); // 0 = idle、以降クリック回数
  const timer = useRef<number | null>(null);

  const clearTimer = () => {
    if (timer.current !== null) {
      clearTimeout(timer.current);
      timer.current = null;
    }
  };
  useEffect(() => clearTimer, []); // アンマウント時に確実に解除

  const onClick = () => {
    const next = armed + 1;
    if (next >= clicks) {
      clearTimer();
      setArmed(0);
      onConfirm();
      return;
    }
    setArmed(next);
    clearTimer();
    timer.current = window.setTimeout(() => setArmed(0), resetMs);
  };

  const remaining = clicks - armed;
  const label =
    armed === 0 ? idleLabel : armedLabel ? armedLabel(remaining) : `あと${remaining}回`;

  return (
    <button
      type="button"
      className={`${className ?? ''}${armed > 0 ? ' confirm-arming' : ''}`}
      title={title}
      disabled={disabled}
      aria-label={idleLabel}
      onClick={onClick}
    >
      {label}
    </button>
  );
}
