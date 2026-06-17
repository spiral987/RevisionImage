import { describe, it, expect } from 'vitest';
import '../src/engine/operations';
import { EditorSession } from '../src/session';
import { createInitialState, getNode } from '../src/engine/editorState';
import { applyOperation } from '../src/engine/operation';
import { selectedCellId } from '../src/backend/variant';
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
function buildAxisSession(mode: VariantAxis['mode'] = 'exclusive'): {
  s: EditorSession;
  axis: VariantAxis;
} {
  const s = new EditorSession(W, H);
  for (const id of ['cellA', 'cellB', 'cellC']) {
    s.apply(createAddLayerOp(id, id, W, H));
  }
  s.apply(createAddGroupOp('slot', '差し替え点'));
  // 3 セルを slot グループに入れる。
  s.apply(createMoveNodeOp('cellA', 'slot', 0));
  s.apply(createMoveNodeOp('cellB', 'slot', 1));
  s.apply(createMoveNodeOp('cellC', 'slot', 2));

  const axis = s.addAxis('目', 'slot', mode);
  s.addCell(axis.id, { id: 'cellA', name: '目A' });
  s.addCell(axis.id, { id: 'cellB', name: '目B' });
  s.addCell(axis.id, { id: 'cellC', name: '目C' });
  return { s, axis };
}

describe('空間軸（Variants）データモデル', () => {
  it('exclusive: セル選択でちょうど1つだけ表示になる', () => {
    const { s, axis } = buildAxisSession('exclusive');
    expect(s.selectCell(axis.id, 'cellB')).toBe(true);
    expect(visible(s, 'cellA')).toBe(false);
    expect(visible(s, 'cellB')).toBe(true);
    expect(visible(s, 'cellC')).toBe(false);
    expect(selectedCellId(axis, s.state)).toBe('cellB');

    // 別セルへ切替: ちょうど 1 つに保たれる。
    expect(s.selectCell(axis.id, 'cellC')).toBe(true);
    expect([visible(s, 'cellA'), visible(s, 'cellB'), visible(s, 'cellC')]).toEqual([
      false,
      false,
      true,
    ]);

    // 既に選択中のセルを再選択しても可視構成は変わらない（op を出さない）。
    expect(s.selectCell(axis.id, 'cellC')).toBe(false);
  });

  it('toggle: 各セルを独立に表示反転する（他セルは不変）', () => {
    const { s, axis } = buildAxisSession('toggle');
    // 初期は全可視。cellA をトグル → cellA だけ非表示、他は不変。
    expect(s.selectCell(axis.id, 'cellA')).toBe(true);
    expect([visible(s, 'cellA'), visible(s, 'cellB'), visible(s, 'cellC')]).toEqual([
      false,
      true,
      true,
    ]);
    // もう一度トグル → 戻る。
    expect(s.selectCell(axis.id, 'cellA')).toBe(true);
    expect(visible(s, 'cellA')).toBe(true);
  });

  it('選択 op は replay 整合（state === replay(log)）を保つ', () => {
    const { s, axis } = buildAxisSession('exclusive');
    s.selectCell(axis.id, 'cellB');
    s.selectCell(axis.id, 'cellA');
    expect(statesEqual(s.state, replay(s))).toBe(true);
  });

  it('1 回の選択は 1 undo にまとまる（exclusive の複数 op でも）', () => {
    const { s, axis } = buildAxisSession('exclusive');
    const before = s.state;
    s.selectCell(axis.id, 'cellB'); // hide A + hide C = 2 op だが 1 undo 単位
    expect(s.undo()).toBe(true);
    expect(statesEqual(s.state, before)).toBe(true);
  });

  it('軸に属さないセル / 不明な軸は無視する', () => {
    const { s, axis } = buildAxisSession('exclusive');
    expect(s.selectCell(axis.id, 'no-such-cell')).toBe(false);
    expect(s.selectCell('no-such-axis', 'cellA')).toBe(false);
  });

  it('addCell は冪等（同じ nodeId は重複登録しない）/ remove / reorder / mode', () => {
    const { s, axis } = buildAxisSession('exclusive');
    expect(s.addCell(axis.id, { id: 'cellA', name: 'dup' })).toBe(false);
    expect(s.getAxis(axis.id)!.cells.map((c) => c.id)).toEqual(['cellA', 'cellB', 'cellC']);

    expect(s.reorderCell(axis.id, 'cellC', 0)).toBe(true);
    expect(s.getAxis(axis.id)!.cells.map((c) => c.id)).toEqual(['cellC', 'cellA', 'cellB']);

    expect(s.removeCell(axis.id, 'cellA')).toBe(true);
    expect(s.getAxis(axis.id)!.cells.map((c) => c.id)).toEqual(['cellC', 'cellB']);

    expect(s.setAxisMode(axis.id, 'toggle')).toBe(true);
    expect(s.getAxis(axis.id)!.mode).toBe('toggle');
    expect(s.setAxisMode(axis.id, 'toggle')).toBe(false); // 変化なし

    expect(s.removeAxis(axis.id)).toBe(true);
    expect(s.axes.length).toBe(0);
  });

  it('JSON 往復で axes が保たれる（sourceRevId 含む）', () => {
    const { s, axis } = buildAxisSession('exclusive');
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
    expect(a.mode).toBe('exclusive');
    expect(a.cells.map((c) => c.id)).toEqual(['cellA', 'cellB', 'cellC', 'cellD']);
    expect(a.cells.find((c) => c.id === 'cellD')!.sourceRevId).toBe('rev-xyz');
  });

  it('reset / loadProject(axes 省略) は axes を空にする', () => {
    const { s } = buildAxisSession('exclusive');
    s.reset();
    expect(s.axes.length).toBe(0);

    const { s: s2 } = buildAxisSession('exclusive');
    s2.loadProject({ log: [], revisions: [] }); // axes 省略
    expect(s2.axes.length).toBe(0);
  });
});
