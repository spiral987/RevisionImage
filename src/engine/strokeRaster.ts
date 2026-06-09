import type { ImageBuffer, StrokePoint } from '../types';

/** 1ピクセルに対する書き込みコールバック。alpha は 0..1 のカバレッジ。 */
export type StampFn = (buf: ImageBuffer, x: number, y: number, alpha: number) => void;

/**
 * 点列(strokes)を円形ダブの連続としてバッファにラスタライズする（決定的）。
 * 座標はキャンバス座標で渡され、レイヤのオフセット分を引いてレイヤローカル座標に変換する。
 *
 * サブストローク境界: 点に down=true があれば（および先頭点は暗黙に）新しいサブストロークの
 * 開始として扱い、直前点との接続線を引かずにその点を単独スタンプする。これにより、別操作を
 * 連結して統合しても操作間に偽の線が出ず、統合1回適用と逐次適用がビット同一になる。
 *
 * 決定性: 全演算は浮動小数だが入力が同じなら出力も同じ。
 */
export function rasterizeStroke(
  buf: ImageBuffer,
  strokes: StrokePoint[],
  baseRadius: number,
  offsetX: number,
  offsetY: number,
  stamp: StampFn,
): void {
  if (strokes.length === 0) return;

  const stampCircle = (cx: number, cy: number, radius: number): void => {
    if (radius <= 0) return;
    const x0 = Math.floor(cx - radius - 1);
    const x1 = Math.ceil(cx + radius + 1);
    const y0 = Math.floor(cy - radius - 1);
    const y1 = Math.ceil(cy + radius + 1);
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const dx = x + 0.5 - cx;
        const dy = y + 0.5 - cy;
        const dist = Math.sqrt(dx * dx + dy * dy);
        const coverage = radius - dist + 0.5; // 1px 幅のアンチエイリアス
        if (coverage > 0) stamp(buf, x, y, coverage > 1 ? 1 : coverage);
      }
    }
  };

  for (let i = 0; i < strokes.length; i++) {
    const p = strokes[i];
    if (i === 0 || p.down) {
      // サブストロークの開始: 点を1回スタンプ（前点との接続線は引かない）。
      stampCircle(p.x - offsetX, p.y - offsetY, baseRadius * p.pressure);
      continue;
    }
    // 同一サブストローク内の継続点: 直前点との区間を spacing 間隔で補間してスタンプ。
    const p0 = strokes[i - 1];
    const dx = p.x - p0.x;
    const dy = p.y - p0.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    const spacing = Math.max(0.5, baseRadius * 0.5);
    const steps = Math.max(1, Math.ceil(dist / spacing));
    for (let s = 1; s <= steps; s++) {
      const t = s / steps;
      const cx = p0.x + dx * t - offsetX;
      const cy = p0.y + dy * t - offsetY;
      const pr = p0.pressure + (p.pressure - p0.pressure) * t;
      stampCircle(cx, cy, baseRadius * pr);
    }
  }
}
