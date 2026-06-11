import { useEffect, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';

// ---- 色変換ヘルパ（純粋） --------------------------------------------------
function hexToRgb(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return [0, 0, 0];
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function rgbToHex(r: number, g: number, b: number): string {
  const h = (v: number) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
  return `#${h(r)}${h(g)}${h(b)}`;
}
function rgbToHsv(r: number, g: number, b: number): { h: number; s: number; v: number } {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  if (d) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return { h, s: max ? d / max : 0, v: max };
}
function hsvToRgb(h: number, s: number, v: number): [number, number, number] {
  const c = v * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = v - c;
  let r = 0;
  let g = 0;
  let b = 0;
  if (h < 60) [r, g] = [c, x];
  else if (h < 120) [r, g] = [x, c];
  else if (h < 180) [g, b] = [c, x];
  else if (h < 240) [g, b] = [x, c];
  else if (h < 300) [r, b] = [x, c];
  else [r, b] = [c, x];
  return [(r + m) * 255, (g + m) * 255, (b + m) * 255];
}
const hexToHsv = (hex: string) => {
  const [r, g, b] = hexToRgb(hex);
  return rgbToHsv(r, g, b);
};
const hsvToHex = (h: number, s: number, v: number) => rgbToHex(...hsvToRgb(h, s, v));

const clamp01 = (x: number) => Math.max(0, Math.min(1, x));

// ジオメトリ（CSS と一致させる）
const WHEEL = 140; // 色相環の直径
const R_OUTER = WHEEL / 2; // 70
const R_INNER = 44; // 穴の半径（mask と一致）
const R_THUMB = (R_OUTER + R_INNER) / 2; // 色相つまみ位置
const SV = 60; // SV 正方形の一辺
const PALETTE_KEY = 'nrc-palette';
const PALETTE_MAX = 24;

/**
 * 常時表示の色相環カラーピッカー + 保存パレット。
 * HSV を内部状態で持ち（hex 往復で色相が失われないように）、変化時に hex を onChange する。
 * パレットは localStorage に永続化（プロジェクトとは独立したユーザー設定）。
 */
export function ColorPicker({ color, onChange }: { color: string; onChange: (hex: string) => void }) {
  const [hsv, setHsv] = useState(() => hexToHsv(color));
  const hsvRef = useRef(hsv);
  hsvRef.current = hsv;

  const wheelRef = useRef<HTMLDivElement>(null);
  const svRef = useRef<HTMLDivElement>(null);
  const hueDragRef = useRef(false);
  const svDragRef = useRef(false);

  const [hexText, setHexText] = useState(color);
  const [palette, setPalette] = useState<string[]>(() => {
    try {
      const v = JSON.parse(localStorage.getItem(PALETTE_KEY) || '[]');
      return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : [];
    } catch {
      return [];
    }
  });

  // 外部から color が変わったら（スポイト/パレット選択等）内部 HSV と hex 入力を同期。
  useEffect(() => {
    if (hsvToHex(hsvRef.current.h, hsvRef.current.s, hsvRef.current.v).toLowerCase() !== color.toLowerCase()) {
      setHsv(hexToHsv(color));
    }
    setHexText(color);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [color]);

  useEffect(() => {
    localStorage.setItem(PALETTE_KEY, JSON.stringify(palette));
  }, [palette]);

  const apply = (next: { h: number; s: number; v: number }) => {
    setHsv(next);
    onChange(hsvToHex(next.h, next.s, next.v));
  };

  const updateHue = (clientX: number, clientY: number) => {
    const el = wheelRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const dx = clientX - (rect.left + rect.width / 2);
    const dy = clientY - (rect.top + rect.height / 2);
    if (Math.hypot(dx, dy) < R_INNER - 4) return; // 穴の内側は無視（SV とのクリック競合回避）
    const h = ((Math.atan2(dx, -dy) * 180) / Math.PI + 360) % 360; // 上=0°, 時計回り
    apply({ ...hsvRef.current, h });
  };

  const updateSV = (clientX: number, clientY: number) => {
    const el = svRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const s = clamp01((clientX - rect.left) / rect.width);
    const v = 1 - clamp01((clientY - rect.top) / rect.height);
    apply({ ...hsvRef.current, s, v });
  };

  const onHueDown = (e: ReactPointerEvent) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    hueDragRef.current = true;
    updateHue(e.clientX, e.clientY);
  };
  const onSvDown = (e: ReactPointerEvent) => {
    e.stopPropagation(); // 親(色相環)の pointerdown を発火させない
    e.currentTarget.setPointerCapture(e.pointerId);
    svDragRef.current = true;
    updateSV(e.clientX, e.clientY);
  };

  const onHexInput = (v: string) => {
    setHexText(v);
    const m = /^#?([0-9a-f]{6})$/i.exec(v.trim());
    if (m) onChange(`#${m[1].toLowerCase()}`);
  };

  const addCurrent = () =>
    setPalette((p) => (p.includes(color) ? p : [color, ...p].slice(0, PALETTE_MAX)));
  const removeAt = (i: number) => setPalette((p) => p.filter((_, j) => j !== i));

  const hueRad = (hsv.h * Math.PI) / 180;
  const thumbX = R_OUTER + R_THUMB * Math.sin(hueRad);
  const thumbY = R_OUTER - R_THUMB * Math.cos(hueRad);
  const hueHex = hsvToHex(hsv.h, 1, 1);

  return (
    <div className="color-picker">
      <div className="cp-top">
        <div
          ref={wheelRef}
          className="cp-wheel"
          style={{ width: WHEEL, height: WHEEL }}
          onPointerDown={onHueDown}
          onPointerMove={(e) => hueDragRef.current && updateHue(e.clientX, e.clientY)}
          onPointerUp={() => (hueDragRef.current = false)}
          onPointerCancel={() => (hueDragRef.current = false)}
        >
          <div className="cp-hue-ring" />
          <div
            className="cp-hue-thumb"
            style={{ left: thumbX, top: thumbY, background: hueHex }}
          />
          <div
            ref={svRef}
            className="cp-sv"
            style={{
              width: SV,
              height: SV,
              left: R_OUTER - SV / 2,
              top: R_OUTER - SV / 2,
              background: `linear-gradient(to top, #000, transparent), linear-gradient(to right, #fff, ${hueHex})`,
            }}
            onPointerDown={onSvDown}
            onPointerMove={(e) => svDragRef.current && updateSV(e.clientX, e.clientY)}
            onPointerUp={() => (svDragRef.current = false)}
            onPointerCancel={() => (svDragRef.current = false)}
          >
            <div
              className="cp-sv-thumb"
              style={{ left: hsv.s * SV, top: (1 - hsv.v) * SV }}
            />
          </div>
        </div>
      </div>

      <div className="cp-row">
        <span className="cp-current" style={{ background: color }} />
        <input
          className="cp-hex"
          value={hexText}
          spellCheck={false}
          onChange={(e) => onHexInput(e.target.value)}
        />
        <button className="cp-add" title="現在の色をパレットに保存" onClick={addCurrent}>
          ＋
        </button>
      </div>

      {palette.length > 0 && (
        <div className="cp-palette">
          {palette.map((c, i) => (
            <button
              key={`${c}-${i}`}
              className={`cp-swatch ${c.toLowerCase() === color.toLowerCase() ? 'active' : ''}`}
              style={{ background: c }}
              title={`${c}（右クリックで削除）`}
              onClick={() => onChange(c)}
              onContextMenu={(e) => {
                e.preventDefault();
                removeAt(i);
              }}
            />
          ))}
        </div>
      )}
    </div>
  );
}
