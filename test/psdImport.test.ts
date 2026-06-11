import { describe, it, expect, vi } from 'vitest';

// ag-psd の readPsd をモックして、canvas 非依存で「ツリー→ops→replay」の構造復元を検証する。
vi.mock('ag-psd', () => ({
  readPsd: () => ({
    width: 32,
    height: 24,
    children: [
      // PSD children は上→下順。
      {
        name: 'Group A',
        opened: true,
        children: [
          { name: 'L1', left: 2, top: 3, hidden: false, opacity: 1 },
          { name: 'L2', left: 0, top: 0, hidden: true, opacity: 0.5 },
        ],
      },
      { name: 'BG layer', left: 0, top: 0, opacity: 1 },
    ],
  }),
}));

import { buildOpsFromPsd } from '../src/frontend/psdImport';
import { createInitialState, getNode } from '../src/engine/editorState';
import { applyOperation } from '../src/engine/operation';
import { isGroup } from '../src/engine/layer';

describe('PSD インポート（ツリー → ops → replay）', () => {
  it('グループ/順序/表示/不透明度が復元される', async () => {
    const fakeFile = { arrayBuffer: async () => new ArrayBuffer(8) } as unknown as File;
    const { width, height, ops } = await buildOpsFromPsd(fakeFile);
    expect(width).toBe(32);
    expect(height).toBe(24);

    let s = createInitialState(width, height);
    for (const op of ops) s = applyOperation(s, op);

    // 既定 Background は削除され、最上位は下→上で [BG layer, Group A]。
    expect(s.layers.map((n) => n.name)).toEqual(['BG layer', 'Group A']);

    const g = getNode(s, s.layers[1].id)!;
    expect(isGroup(g)).toBe(true);
    if (!isGroup(g)) return;
    // グループ内も下→上: PSD [L1, L2] → [L2, L1]
    expect(g.children.map((c) => c.name)).toEqual(['L2', 'L1']);

    const l2 = g.children.find((c) => c.name === 'L2')!;
    expect(l2.visible).toBe(false);
    expect(l2.opacity).toBeCloseTo(0.5);
  });
});
