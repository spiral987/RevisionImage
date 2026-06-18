import { describe, it, expect } from 'vitest';
import '../src/engine/operations';
import { EditorSession } from '../src/session';
import { createInitialState, getNode } from '../src/engine/editorState';
import { applyOperation } from '../src/engine/operation';
import {
  cellPreviewState,
  slotChildren,
  listGroups,
} from '../src/backend/variant';
import { serializeProject } from '../src/backend/repository';
import {
  createAddLayerOp,
  createAddGroupOp,
  createMoveNodeOp,
} from '../src/engine/operations';
import type { VariantAxis } from '../src/types';
import { statesEqual } from './helpers';

const W = 16;
const H = 16;

/** s.getLog() を初期状態から replay した state（不変条件 state === replay(log) の検査用）。 */
function replay(s: EditorSession) {
  let st = createInitialState(s.width, s.height);
  for (const op of s.getLog()) st = applyOperation(st, op);
  return st;
}

const visible = (s: EditorSession, id: string) => getNode(s.state, id)!.visible;

/**
 * slot グループ「slot」配下に 3 つのセルレイヤー(cellA/B/C)を持つ文書を作り、
 * それらを束ねる空間軸を 1 つ登録したセッションを返す。
 */
function buildAxisSession(): { s: EditorSession; axis: VariantAxis } {
  const s = new EditorSession(W, H);
  for (const id of ['cellA', 'cellB', 'cellC']) {
    s.apply(createAddLayerOp(id, id, W, H));
  }
  s.apply(createAddGroupOp('slot', '差し替え点'));
  s.apply(createMoveNodeOp('cellA', 'slot', 0));
  s.apply(createMoveNodeOp('cellB', 'slot', 1));
  s.apply(createMoveNodeOp('cellC', 'slot', 2));

  const axis = s.addAxis('目', 'slot');
  s.addCell(axis.id, { id: 'cellA', name: '目A' });
  s.addCell(axis.id, { id: 'cellB', name: '目B' });
  s.addCell(axis.id, { id: 'cellC', name: '目C' });
  return { s, axis };
}

describe('空間軸（Variants）データモデル', () => {
  it('toggleCell: 各セルを独立に表示反転する（他セルは不変）', () => {
    const { s, axis } = buildAxisSession();
    // 初期は全可視。cellA をトグル → cellA だけ非表示、他は不変。
    expect(s.toggleCell(axis.id, 'cellA')).toBe(true);
    expect([visible(s, 'cellA'), visible(s, 'cellB'), visible(s, 'cellC')]).toEqual([
      false,
      true,
      true,
    ]);
    // cellB もトグル → 2 つ非表示（独立）。
    expect(s.toggleCell(axis.id, 'cellB')).toBe(true);
    expect([visible(s, 'cellA'), visible(s, 'cellB'), visible(s, 'cellC')]).toEqual([
      false,
      false,
      true,
    ]);
    // cellA を再トグル → 戻る。
    expect(s.toggleCell(axis.id, 'cellA')).toBe(true);
    expect(visible(s, 'cellA')).toBe(true);
  });

  it('トグル op は replay 整合（state === replay(log)）を保つ', () => {
    const { s, axis } = buildAxisSession();
    s.toggleCell(axis.id, 'cellB');
    s.toggleCell(axis.id, 'cellA');
    expect(statesEqual(s.state, replay(s))).toBe(true);
  });

  it('1 回のトグルは 1 undo で戻る', () => {
    const { s, axis } = buildAxisSession();
    const before = s.state;
    s.toggleCell(axis.id, 'cellB');
    expect(s.undo()).toBe(true);
    expect(statesEqual(s.state, before)).toBe(true);
  });

  it('軸に属さないセル / 不明な軸は無視する', () => {
    const { s, axis } = buildAxisSession();
    expect(s.toggleCell(axis.id, 'no-such-cell')).toBe(false);
    expect(s.toggleCell('no-such-axis', 'cellA')).toBe(false);
  });

  it('addCell は冪等（同じ nodeId は重複登録しない）/ remove / reorder', () => {
    const { s, axis } = buildAxisSession();
    expect(s.addCell(axis.id, { id: 'cellA', name: 'dup' })).toBe(false);
    expect(s.getAxis(axis.id)!.cells.map((c) => c.id)).toEqual(['cellA', 'cellB', 'cellC']);

    expect(s.reorderCell(axis.id, 'cellC', 0)).toBe(true);
    expect(s.getAxis(axis.id)!.cells.map((c) => c.id)).toEqual(['cellC', 'cellA', 'cellB']);

    expect(s.removeCell(axis.id, 'cellA')).toBe(true);
    expect(s.getAxis(axis.id)!.cells.map((c) => c.id)).toEqual(['cellC', 'cellB']);

    expect(s.removeAxis(axis.id)).toBe(true);
    expect(s.axes.length).toBe(0);
  });

  it('JSON 往復で axes が保たれる（sourceRevId 含む）', () => {
    const { s, axis } = buildAxisSession();
    s.addCell(axis.id, { id: 'cellD', name: '目D（過去版由来）', sourceRevId: 'rev-xyz' });

    const json = JSON.parse(
      JSON.stringify(
        serializeProject({
          width: W,
          height: H,
          log: s.getLog(),
          revisions: s.revisions,
          axes: s.axes,
        }),
      ),
    );
    const restored = new EditorSession(W, H);
    restored.loadProject(json);

    expect(restored.axes.length).toBe(1);
    const a = restored.axes[0];
    expect(a.name).toBe('目');
    expect(a.slotId).toBe('slot');
    expect(a.cells.map((c) => c.id)).toEqual(['cellA', 'cellB', 'cellC', 'cellD']);
    expect(a.cells.find((c) => c.id === 'cellD')!.sourceRevId).toBe('rev-xyz');
  });

  it('reset / loadProject(axes 省略) は axes を空にする', () => {
    const { s } = buildAxisSession();
    s.reset();
    expect(s.axes.length).toBe(0);

    const { s: s2 } = buildAxisSession();
    s2.loadProject({ log: [], revisions: [] }); // axes 省略
    expect(s2.axes.length).toBe(0);
  });
});

describe('空間軸（Variants）オーサリング & プレビュー', () => {
  it('syncAxisCells: slot 直下の子をセルに取り込み、外れた子は落とす', () => {
    const s = new EditorSession(W, H);
    for (const id of ['cellA', 'cellB']) s.apply(createAddLayerOp(id, id, W, H));
    s.apply(createAddGroupOp('slot', 'slot'));
    s.apply(createMoveNodeOp('cellA', 'slot', 0));
    s.apply(createMoveNodeOp('cellB', 'slot', 1));

    const axis = s.addAxis('目', 'slot'); // cells は空
    expect(axis.cells.length).toBe(0);
    expect(s.syncAxisCells(axis.id)).toBe(true);
    expect(s.getAxis(axis.id)!.cells.map((c) => c.id)).toEqual(['cellA', 'cellB']);
    // 変化が無ければ false
    expect(s.syncAxisCells(axis.id)).toBe(false);

    // cellA を slot の外へ出す → 同期でセルから落ちる。
    s.apply(createMoveNodeOp('cellA', null, 0));
    expect(s.syncAxisCells(axis.id)).toBe(true);
    expect(s.getAxis(axis.id)!.cells.map((c) => c.id)).toEqual(['cellB']);
  });

  it('cellPreviewState: slot 内で対象セルだけ可視・他は不可視（state は不変）', () => {
    const { s, axis } = buildAxisSession();
    const before = s.state;
    const preview = cellPreviewState(s.state, axis, 'cellB');
    expect(getNode(preview, 'cellA')!.visible).toBe(false);
    expect(getNode(preview, 'cellB')!.visible).toBe(true);
    expect(getNode(preview, 'cellC')!.visible).toBe(false);
    expect(getNode(preview, 'slot')!.visible).toBe(true);
    // 元 state は変更されない（純関数）。
    expect(s.state).toBe(before);
    expect(getNode(s.state, 'cellA')!.visible).toBe(true);
  });

  it('slotChildren / listGroups がツリーから候補を返す', () => {
    const { s } = buildAxisSession();
    expect(slotChildren(s.state, 'slot').map((c) => c.id)).toEqual(['cellA', 'cellB', 'cellC']);
    expect(listGroups(s.state).map((g) => g.id)).toContain('slot');
  });
});
