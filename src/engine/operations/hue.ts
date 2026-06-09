import type { BBox, EditorState, Operation } from '../../types';
import type { OpHandler } from '../operation';
import { getLayer, replaceLayer } from '../editorState';
import { cloneLayer } from '../layer';
import { fullCanvas } from '../geom';
import { genId } from '../../util/id';

export interface HueParams {
  shift: number; // 色相回転(度)
}

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  const d = max - min;
  let h = 0;
  let s = 0;
  if (d !== 0) {
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === rn) h = (gn - bn) / d + (gn < bn ? 6 : 0);
    else if (max === gn) h = (bn - rn) / d + 2;
    else h = (rn - gn) / d + 4;
    h *= 60;
  }
  return [h, s, l];
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const hh = ((h % 360) + 360) % 360;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((hh / 60) % 2) - 1));
  const m = l - c / 2;
  let r = 0;
  let g = 0;
  let b = 0;
  if (hh < 60) {
    r = c;
    g = x;
  } else if (hh < 120) {
    r = x;
    g = c;
  } else if (hh < 180) {
    g = c;
    b = x;
  } else if (hh < 240) {
    g = x;
    b = c;
  } else if (hh < 300) {
    r = x;
    b = c;
  } else {
    r = c;
    b = x;
  }
  return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
}

export const hueHandler: OpHandler = {
  type: 'hue',
  klass: 'color',

  apply(state: EditorState, op: Operation): EditorState {
    const layer = getLayer(state, op.layerId);
    if (!layer) return state;
    const { shift } = op.params as unknown as HueParams;
    const newLayer = cloneLayer(layer);
    const d = newLayer.buffer.data;
    for (let i = 0; i < d.length; i += 4) {
      const [h, s, l] = rgbToHsl(d[i], d[i + 1], d[i + 2]);
      const [r, g, b] = hslToRgb(h + shift, s, l);
      d[i] = r;
      d[i + 1] = g;
      d[i + 2] = b;
    }
    return replaceLayer(state, newLayer);
  },

  // RGB↔HSL の往復丸めにより色相加算は厳密には非結合なので統合しない。
};

export function createHueOp(
  layerId: string,
  shift: number,
  width: number,
  height: number,
  region?: BBox,
): Operation {
  return {
    id: genId('hue'),
    type: 'hue',
    klass: 'color',
    params: { shift },
    region: region ?? fullCanvas(width, height),
    layerId,
    timestamp: Date.now(),
  };
}
