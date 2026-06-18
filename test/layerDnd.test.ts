import { describe, it, expect } from 'vitest';
import '../src/engine/operations';
import { reorderIndex } from '../src/frontend/layerDnd';
import { EditorSession } from '../src/session';
import { createAddLayerOp, createMoveNodeOp } from '../src/engine/operations';
import { getParentInfo } from '../src/engine/editorState';

describe('レイヤー D&D の index 計算', () => {
  it('reorderIndex: 逆順表示の above/below と同一親シフト', () => {
    // 別親（fromIndexSameParent = null）: above=対象の前面側= index+1。
    expect(reorderIndex('above', 1, null)).toBe(2);
    expect(reorderIndex('below', 1, null)).toBe(1);
    // 同一親で元が挿入位置より前 → 除去で 1 つ詰まる。
    expect(reorderIndex('above', 1, 0)).toBe(1); // 2 -> 1
    expect(reorderIndex('below', 1, 0)).toBe(0); // 1 -> 0
    // 同一親で元が後ろ（詰まらない）。
    expect(reorderIndex('above', 0, 2)).toBe(1);
    expect(reorderIndex('below', 0, 2)).toBe(0);
  });

  it('moveNode と組み合わせ: 視覚上の並べ替えが正しい配列になる', () => {
    const s = new EditorSession(16, 16);
    // 配列=[base,A,B,C]、視覚(上=最前面)= C,B,A,base。
    for (const id of ['A', 'B', 'C']) s.apply(createAddLayerOp(id, id, 16, 16));
    const order = () => s.state.layers.map((n) => n.id);
    expect(order()).toEqual(['layer-base', 'A', 'B', 'C']);

    // A を「B の above（視覚で C と B の間）」へドロップ。
    const idxB = getParentInfo(s.state, 'B')!.index;
    const fromA = getParentInfo(s.state, 'A')!.index;
    s.apply(createMoveNodeOp('A', null, reorderIndex('above', idxB, fromA)));
    expect(order()).toEqual(['layer-base', 'B', 'A', 'C']); // 視覚 上→下: C,A,B,base
  });
});
