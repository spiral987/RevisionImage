import type { ImageBuffer, StrokePoint } from '../types';

/** 1ピクセルに対する書き込みコールバック。alpha は 0..1 のカバレッジ。 */
export type StampFn = (buf: ImageBuffer, x: number, y: number, alpha: number) => void;

/**
 * 中心(cx,cy)・半径 radius の円形ダブを1個スタンプする（座標はバッファローカル）。
 * coverage は半径からの距離で 1px 幅のアンチエイリアスを掛ける。決定的。
 */
function stampCircle(buf: ImageBuffer, cx: number, cy: number, radius: number, stamp: StampFn): void {
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
}

/**
 * サブストローク開始点（または単独点）を1回スタンプする。座標はキャンバス座標で渡され、
 * オフセット分を引いてレイヤローカルへ変換する。
 */
export function stampDab(
  buf: ImageBuffer,
  p: StrokePoint,
  baseRadius: number,
  offsetX: number,
  offsetY: number,
  stamp: StampFn,
): void {
  stampCircle(buf, p.x - offsetX, p.y - offsetY, baseRadius * p.pressure, stamp);
}

/**
 * 区間 (p0, p1] を spacing 間隔のダブで補間スタンプする（p0 自体は打たない＝隣接区間との二重塗り防止）。
 * spacing は「区間内で最小となるスタンプ半径」に比例させ、筆圧が低く半径が小さい区間でも必ずダブが
 * 重なる（spacing ≤ 半径）ため、粒状の隙間が出ず滑らかな線になる。座標はキャンバス座標。
 *
 * ライブプレビューはこの関数で「新しい区間だけ」を増分スタンプでき、rasterizeStroke の逐次適用と
 * 同じダブ列・同じ順序になる（プレビューと確定結果がほぼ一致）。
 */
export function rasterizeSegment(
  buf: ImageBuffer,
  p0: StrokePoint,
  p1: StrokePoint,
  baseRadius: number,
  offsetX: number,
  offsetY: number,
  stamp: StampFn,
): void {
  const dx = p1.x - p0.x;
  const dy = p1.y - p0.y;
  const dist = Math.sqrt(dx * dx + dy * dy);
  const minPr = Math.max(0.05, Math.min(p0.pressure, p1.pressure));
  const spacing = Math.max(0.35, baseRadius * minPr * 0.35);
  const steps = Math.max(1, Math.ceil(dist / spacing));
  for (let s = 1; s <= steps; s++) {
    const t = s / steps;
    const cx = p0.x + dx * t - offsetX;
    const cy = p0.y + dy * t - offsetY;
    const pr = p0.pressure + (p1.pressure - p0.pressure) * t;
    stampCircle(buf, cx, cy, baseRadius * pr, stamp);
  }
}

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
  for (let i = 0; i < strokes.length; i++) {
    const p = strokes[i];
    if (i === 0 || p.down) {
      // サブストロークの開始: 点を1回スタンプ（前点との接続線は引かない）。
      stampDab(buf, p, baseRadius, offsetX, offsetY, stamp);
      continue;
    }
    // 同一サブストローク内の継続点: 直前点との区間を spacing 間隔で補間してスタンプ。
    rasterizeSegment(buf, strokes[i - 1], p, baseRadius, offsetX, offsetY, stamp);
  }
}
