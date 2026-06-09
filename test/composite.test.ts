import { describe, it, expect } from 'vitest';
import { createInitialState } from '../src/engine/editorState';
import { createLayer } from '../src/engine/layer';
import { flattenState } from '../src/engine/composite';

describe('flattenState (純TS合成)', () => {
  it('不透明レイヤを白背景の上に合成し、未塗り部分は背景色になる', () => {
    const s = createInitialState(2, 1);
    s.layers[0].buffer.data.set([255, 0, 0, 255], 0); // (0,0) を不透明赤に
    const flat = flattenState(s);
    expect(Array.from(flat.data.slice(0, 4))).toEqual([255, 0, 0, 255]); // 赤
    expect(Array.from(flat.data.slice(4, 8))).toEqual([255, 255, 255, 255]); // 白背景
  });

  it('半透明レイヤは背景とブレンドされる（赤 a=128 over 白 → 255,127,127）', () => {
    const s = createInitialState(1, 1);
    s.layers[0].buffer.data.set([255, 0, 0, 128], 0);
    const flat = flattenState(s);
    expect(Array.from(flat.data.slice(0, 4))).toEqual([255, 127, 127, 255]);
  });

  it('レイヤの offset を反映して合成する', () => {
    const s = createInitialState(3, 1);
    const top = createLayer('top', 'Top', 3, 1);
    top.buffer.data.set([0, 0, 255, 255], 0); // top のローカル(0,0) を青
    top.offsetX = 2; // → キャンバス(2,0) に出る
    s.layers.push(top);
    const flat = flattenState(s);
    expect(Array.from(flat.data.slice(0, 4))).toEqual([255, 255, 255, 255]); // (0,0) 白
    expect(Array.from(flat.data.slice(8, 12))).toEqual([0, 0, 255, 255]); // (2,0) 青
  });

  it('背景色を指定できる（透明背景）', () => {
    const s = createInitialState(1, 1);
    const flat = flattenState(s, { background: [0, 0, 0, 0] });
    expect(Array.from(flat.data.slice(0, 4))).toEqual([0, 0, 0, 0]);
  });

  it('非整数オフセットでも丸めて合成される（translateプレビュー中の消失を防ぐ回帰テスト）', () => {
    const s = createInitialState(2, 1);
    s.layers[0].buffer.data.set([255, 0, 0, 255], 0); // ローカル(0,0) を赤
    s.layers[0].offsetX = 0.7; // ドラッグ中プレビュー相当の非整数オフセット
    const flat = flattenState(s);
    // 丸めて offsetX=1 → キャンバス(1,0) に赤が出る（消えない）
    expect(Array.from(flat.data.slice(4, 8))).toEqual([255, 0, 0, 255]);
    expect(Array.from(flat.data.slice(0, 4))).toEqual([255, 255, 255, 255]); // (0,0) は白背景
  });

  it('非表示レイヤは合成されない', () => {
    const s = createInitialState(1, 1);
    s.layers[0].buffer.data.set([255, 0, 0, 255], 0);
    s.layers[0].visible = false;
    const flat = flattenState(s);
    expect(Array.from(flat.data.slice(0, 4))).toEqual([255, 255, 255, 255]);
  });
});
