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

// ジオメトリ。穴の半径(R_INNER)はリングの mask をインライン指定するので JS 側が単一の真実。
const WHEEL = 200; // 色相環の直径（拡大）
const R_OUTER = WHEEL / 2; // 100
const R_INNER = 64; // 穴の半径（cp-hue-ring の mask に反映）
const R_THUMB = (R_OUTER + R_INNER) / 2; // 色相つまみ位置
const SV = 88; // SV 正方形の一辺（内円に収まる）
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

  // RGB/HSV スライダー。RGB は現在の HSV から導出し、変更時は HSV へ戻す（グレーでは色相を保つ）。
  const [r, g, b] = hsvToRgb(hsv.h, hsv.s, hsv.v).map((x) => Math.round(x)) as [number, number, number];
  const applyRgb = (nr: number, ng: number, nb: number) => {
    const next = rgbToHsv(nr, ng, nb);
    if (next.s === 0) next.h = hsvRef.current.h; // 無彩色で色相を失わない
    apply(next);
  };
  const svHex = (s: number, v: number) => hsvToHex(hsv.h, s, v);

  // 1 本のスライダー行（色付きトラック + 数値入力）。
  const slider = (
    label: string,
    value: number,
    min: number,
    max: number,
    track: string,
    set: (v: number) => void,
  ) => (
    <div className="cp-slider">
      <span>{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        value={value}
        style={{ background: track }}
        onChange={(e) => set(Number(e.target.value))}
      />
      <input
        type="number"
        min={min}
        max={max}
        value={value}
        onChange={(e) => set(Number(e.target.value))}
      />
    </div>
  );

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
          <div
            className="cp-hue-ring"
            style={{
              WebkitMaskImage: `radial-gradient(circle at center, transparent 0 ${R_INNER}px, #000 ${R_INNER}px)`,
              maskImage: `radial-gradient(circle at center, transparent 0 ${R_INNER}px, #000 ${R_INNER}px)`,
            }}
          />
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

      <div className="cp-sliders">
        <div className="cp-group-label">RGB</div>
        {slider('R', r, 0, 255, `linear-gradient(to right, rgb(0,${g},${b}), rgb(255,${g},${b}))`, (v) =>
          applyRgb(v, g, b),
        )}
        {slider('G', g, 0, 255, `linear-gradient(to right, rgb(${r},0,${b}), rgb(${r},255,${b}))`, (v) =>
          applyRgb(r, v, b),
        )}
        {slider('B', b, 0, 255, `linear-gradient(to right, rgb(${r},${g},0), rgb(${r},${g},255))`, (v) =>
          applyRgb(r, g, v),
        )}
        <div className="cp-group-label">HSV</div>
        {slider(
          'H',
          Math.round(hsv.h),
          0,
          360,
          'linear-gradient(to right, #f00, #ff0, #0f0, #0ff, #00f, #f0f, #f00)',
          (v) => apply({ ...hsvRef.current, h: v }),
        )}
        {slider(
          'S',
          Math.round(hsv.s * 100),
          0,
          100,
          `linear-gradient(to right, ${svHex(0, hsv.v)}, ${svHex(1, hsv.v)})`,
          (v) => apply({ ...hsvRef.current, s: v / 100 }),
        )}
        {slider(
          'V',
          Math.round(hsv.v * 100),
          0,
          100,
          `linear-gradient(to right, #000, ${svHex(hsv.s, 1)})`,
          (v) => apply({ ...hsvRef.current, v: v / 100 }),
        )}
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
