import { describe, it, expect } from 'vitest';
import '../src/engine/operations';
import { EditorSession } from '../src/session';
import { BASE_LAYER_ID } from '../src/engine/editorState';
import { createBrushOp, createAddLayerOp } from '../src/engine/operations';
import { line } from './helpers';

const P = { color: [10, 20, 30] as [number, number, number], size: 4, opacity: 1 };

describe('session.getStats（Debug 窓の集計）', () => {
  it('操作数・ノード数・ストローク点数・レイヤー数・型内訳を集計する', () => {
    const s = new EditorSession(32, 32);
    s.apply(createBrushOp(BASE_LAYER_ID, line(1, 1, 10, 10, 5), P, 32, 32));
    s.apply(createAddLayerOp('layer-2', 'L1', 32, 32)); // 間に挟む→consolidate を切る
    s.apply(createBrushOp('layer-2', line(2, 2, 8, 8, 3), { ...P, color: [9, 9, 9] }, 32, 32));

    const st = s.getStats();
    expect(st.width).toBe(32);
    expect(st.height).toBe(32);
    expect(st.logOps).toBe(3);
    expect(st.dagNodes).toBe(4); // +ROOT（各 op = 1 ノード）
    expect(st.strokePoints).toBe(8); // 5 + 3
    expect(st.layers).toBe(2); // Background + L1
    expect(st.groups).toBe(0);
    expect(st.opTypeCounts.brush).toBe(2);
    expect(st.opTypeCounts.addLayer).toBe(1);
    expect(st.uniqueOps).toBe(3);
  });

  it('commit すると uniqueOps は共有 id を重複排除する（延べは revisionOps に出る）', () => {
    const s = new EditorSession(16, 16);
    s.apply(createBrushOp(BASE_LAYER_ID, line(1, 1, 5, 5, 3), P, 16, 16));
    s.commitRevision('v1'); // rev.ops は作業ログと同一 id を共有
    const st = s.getStats();
    expect(st.revisions).toBe(1);
    expect(st.logOps).toBe(1);
    expect(st.revisionOps).toBe(1); // 延べ
    expect(st.uniqueOps).toBe(1); // 共有 id → 重複排除（実保存量）
  });
});
