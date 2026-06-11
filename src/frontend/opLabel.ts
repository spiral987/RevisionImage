import type { Operation } from '../types';

/** 操作の短い説明（ログパネル・Diff の操作リスト共通）。 */
export function describeOp(op: Operation): string {
  const p = op.params as Record<string, unknown>;
  switch (op.type) {
    case 'brush':
      return `rgb(${(p.color as number[]).join(',')}) size${p.size} · ${op.strokes?.length ?? 0}pts`;
    case 'eraser':
      return `size${p.size} · ${op.strokes?.length ?? 0}pts`;
    case 'translate':
      return `dx${p.dx} dy${p.dy}`;
    case 'brightness':
      return `Δ${p.delta}`;
    case 'hue':
      return `${p.shift}°`;
    case 'addLayer':
      return `${p.name}`;
    case 'addImageLayer':
      return `${p.name} (${p.imgWidth}×${p.imgHeight})`;
    case 'setLayerVisibility':
      return p.visible ? 'show' : 'hide';
    case 'setLayerOpacity':
      return `opacity ${Math.round((p.opacity as number) * 100)}%`;
    case 'renameLayer':
      return `→ "${p.name}"`;
    case 'removeLayer':
      return 'remove';
    case 'reorderLayer':
      return `→ index ${p.toIndex}`;
    case 'clearLayer':
      return 'clear';
    case 'mergeDownLayer':
      return 'merge down';
    case 'addGroup':
      return p.wrapLayerId ? `folder "${p.name}" (wrap)` : `folder "${p.name}"`;
    case 'moveNode':
      return p.parentId ? `→ into ${p.parentId}` : '→ top';
    case 'setGroupCollapsed':
      return p.collapsed ? 'collapse' : 'expand';
    case 'fill':
      return `rgb(${(p.color as number[]).join(',')}) tol${p.tolerance}`;
    case 'transform': {
      const a = p.a as number;
      const b = p.b as number;
      const sx = Math.hypot(a, b);
      const deg = Math.round((Math.atan2(b, a) * 180) / Math.PI);
      return `${sx.toFixed(2)}× ${deg}°`;
    }
    default:
      return JSON.stringify(p);
  }
}
