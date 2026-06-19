import { describe, it, expect } from 'vitest';
import '../src/engine/operations';
import { EditorSession } from '../src/session';
import { createInitialState, getNode } from '../src/engine/editorState';
import { applyOperation } from '../src/engine/operation';
import {
  cellPreviewState,
  slotChildren,
  listGroups,
  onionSkinState,
} from '../src/backend/variant';
import { serializeProject } from '../src/backend/repository';
import {
  createAddLayerOp,
  createAddGroupOp,
  createMoveNodeOp,
  createBrushOp,
  createRemoveLayerOp,
} from '../src/engine/operations';
import { BASE_LAYER_ID } from '../src/engine/editorState';
import type { VariantAxis } from '../src/types';
import { statesEqual, line } from './helpers';

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

  it('renameAxis / renameCell: 注釈のみ変更（空文字・不明 id は無視）', () => {
    const { s, axis } = buildAxisSession();

    expect(s.renameAxis(axis.id, '  口  ')).toBe(true); // trim される
    expect(s.getAxis(axis.id)!.name).toBe('口');
    expect(s.renameAxis(axis.id, '   ')).toBe(false); // 空文字は無視
    expect(s.renameAxis('no-such-axis', 'x')).toBe(false);
    expect(s.getAxis(axis.id)!.name).toBe('口');

    expect(s.renameCell(axis.id, 'cellB', '笑顔')).toBe(true);
    expect(s.getAxis(axis.id)!.cells.find((c) => c.id === 'cellB')!.name).toBe('笑顔');
    expect(s.renameCell(axis.id, 'cellB', '')).toBe(false);
    expect(s.renameCell(axis.id, 'no-such-cell', 'x')).toBe(false);

    // 改名はサイドカーのみ＝ログを汚さない（replay 整合を保つ）。
    expect(statesEqual(s.state, replay(s))).toBe(true);
  });

  it('JSON 往復で axes / boardLayout が保たれる（sourceRevId 含む）', () => {
    const { s, axis } = buildAxisSession();
    s.addCell(axis.id, { id: 'cellD', name: '目D（過去版由来）', sourceRevId: 'rev-xyz' });
    s.setBoardPos('cellA', 120, 40); // 盤面の自由配置
    s.setBoardPos('rev-1', -10, 200);

    const json = JSON.parse(
      JSON.stringify(
        serializeProject({
          width: W,
          height: H,
          log: s.getLog(),
          revisions: s.revisions,
          axes: s.axes,
          boardLayout: s.boardLayout,
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
    expect(restored.getBoardPos('cellA')).toEqual({ x: 120, y: 40 });
    expect(restored.getBoardPos('rev-1')).toEqual({ x: -10, y: 200 });
  });

  it('reset / loadProject(axes 省略) は axes / boardLayout を空にする', () => {
    const { s } = buildAxisSession();
    s.setBoardPos('cellA', 5, 5);
    s.reset();
    expect(s.axes.length).toBe(0);
    expect(s.getBoardPos('cellA')).toBeUndefined();

    const { s: s2 } = buildAxisSession();
    s2.setBoardPos('cellA', 9, 9);
    s2.loadProject({ log: [], revisions: [] }); // axes / boardLayout 省略
    expect(s2.axes.length).toBe(0);
    expect(s2.getBoardPos('cellA')).toBeUndefined();
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

  it('onionSkinState: 隠れたセルを ghost 不透明度で可視化（表示中はそのまま・元は不変）', () => {
    const { s, axis } = buildAxisSession();
    s.toggleCell(axis.id, 'cellB'); // cellB を非表示（A/C は表示のまま）
    const onion = onionSkinState(s.state, axis, 0.3);
    // 全セルが可視
    expect(getNode(onion, 'cellA')!.visible).toBe(true);
    expect(getNode(onion, 'cellB')!.visible).toBe(true);
    expect(getNode(onion, 'cellC')!.visible).toBe(true);
    // 隠れていた cellB は ghost、表示中は不透明のまま
    expect(getNode(onion, 'cellB')!.opacity).toBe(0.3);
    expect(getNode(onion, 'cellA')!.opacity).toBe(1);
    // 元 state は不変（純関数）
    expect(getNode(s.state, 'cellB')!.visible).toBe(false);
  });
});

describe('層2: 時間→空間の昇格（addRevisionAsCell）', () => {
  const P = { color: [10, 120, 220] as [number, number, number], size: 4, opacity: 1 };

  it('過去のコミットを別案セルとして取り込む（slot内・非表示・出自保持・replay整合）', () => {
    const s = new EditorSession(W, H);
    s.apply(createAddGroupOp('slot', 'slot'));
    const axis = s.addAxis('目', 'slot');
    s.apply(createBrushOp(BASE_LAYER_ID, line(2, 2, 12, 12, 5), P, W, H));
    const rev = s.commitRevision('v1');

    expect(s.addRevisionAsCell(axis.id, rev)).toBe(true);
    const cells = s.getAxis(axis.id)!.cells;
    expect(cells.length).toBe(1);
    const cellId = cells[0].id;
    // 出自を保持（時間の読みとの橋）
    expect(cells[0].sourceRevId).toBe(rev.id);
    // slot フォルダ内に配置され、初期は非表示
    expect(slotChildren(s.state, 'slot').map((c) => c.id)).toContain(cellId);
    expect(getNode(s.state, cellId)!.visible).toBe(false);
    // 取り込みも操作ログに残り replay 整合
    expect(statesEqual(s.state, replay(s))).toBe(true);
    // トグルで表示にできる
    expect(s.toggleCell(axis.id, cellId)).toBe(true);
    expect(getNode(s.state, cellId)!.visible).toBe(true);
  });

  it('何も描かれていない版 / slot がフォルダでない / 不明な軸は false', () => {
    const s = new EditorSession(W, H);
    s.apply(createAddGroupOp('slot', 'slot'));
    const axis = s.addAxis('目', 'slot');
    const emptyRev = s.commitRevision('empty'); // 何も描いていない
    expect(s.addRevisionAsCell(axis.id, emptyRev)).toBe(false);

    s.apply(createBrushOp(BASE_LAYER_ID, line(2, 2, 12, 12, 5), P, W, H));
    const rev = s.commitRevision('v1');
    expect(s.addRevisionAsCell('no-such-axis', rev)).toBe(false);

    // slot がリーフ（フォルダでない）軸は取り込めない
    const leafAxis = s.addAxis('x', BASE_LAYER_ID);
    expect(s.addRevisionAsCell(leafAxis.id, rev)).toBe(false);
  });
});

describe('層2: park（退避）', () => {
  const P = { color: [200, 60, 10] as [number, number, number], size: 4, opacity: 1 };

  /** slot 内に1枚レイヤーを置き、そこに描画した文書 + 軸を作る。 */
  function buildDrawnSlot() {
    const s = new EditorSession(W, H);
    s.apply(createAddGroupOp('slot', 'slot'));
    s.apply(createAddLayerOp('cellA', 'cellA', W, H));
    s.apply(createMoveNodeOp('cellA', 'slot', 0));
    s.apply(createBrushOp('cellA', line(2, 2, 12, 12, 5), P, W, H));
    const axis = s.addAxis('目', 'slot');
    s.syncAxisCells(axis.id);
    return { s, axis };
  }

  it('現在の見た目を退避セルにし、作業ビューをクリアする（非破壊・replay整合・引き戻し可）', () => {
    const { s, axis } = buildDrawnSlot();
    expect(getNode(s.state, 'cellA')!.visible).toBe(true);

    expect(s.parkSlot(axis.id)).toBe(true);
    // 元の子は削除されず非表示（非破壊）。
    expect(getNode(s.state, 'cellA')!.visible).toBe(false);
    // 退避スナップショットが隠しセルとして増える（出自なし）。
    const cells = s.getAxis(axis.id)!.cells;
    expect(cells.length).toBe(2);
    const parked = cells[cells.length - 1];
    expect(parked.sourceRevId).toBeUndefined();
    expect(getNode(s.state, parked.id)!.visible).toBe(false);
    expect(slotChildren(s.state, 'slot').map((c) => c.id)).toContain(parked.id);
    // 取り込みも操作ログに残り replay 整合。
    expect(statesEqual(s.state, replay(s))).toBe(true);
    // pull（引き戻し）= トグルで表示。
    expect(s.toggleCell(axis.id, parked.id)).toBe(true);
    expect(getNode(s.state, parked.id)!.visible).toBe(true);
  });

  it('slot に見えるものが無ければ false', () => {
    const { s, axis } = buildDrawnSlot();
    s.toggleCell(axis.id, 'cellA'); // cellA を隠す → 見えるもの無し
    expect(s.parkSlot(axis.id)).toBe(false);
  });
});

describe('層2: pull（セル→作業の引き出し）', () => {
  it('セルを可視にし、編集対象リーフ id を返す（replay 整合）', () => {
    const { s, axis } = buildAxisSession();
    s.toggleCell(axis.id, 'cellB'); // 可視→非表示
    expect(getNode(s.state, 'cellB')!.visible).toBe(false);

    const leaf = s.pullCellToWorking(axis.id, 'cellB');
    expect(leaf).toBe('cellB'); // リーフセルは自身
    expect(getNode(s.state, 'cellB')!.visible).toBe(true); // 可視化される
    expect(statesEqual(s.state, replay(s))).toBe(true);
  });

  it('セルがフォルダなら最初のリーフを返す', () => {
    const s = new EditorSession(W, H);
    s.apply(createAddGroupOp('slot', 'slot'));
    s.apply(createAddGroupOp('cellG', 'cellG')); // フォルダのセル
    s.apply(createAddLayerOp('inner', 'inner', W, H));
    s.apply(createMoveNodeOp('cellG', 'slot', 0));
    s.apply(createMoveNodeOp('inner', 'cellG', 0));
    const axis = s.addAxis('目', 'slot');
    s.syncAxisCells(axis.id);
    expect(s.pullCellToWorking(axis.id, 'cellG')).toBe('inner');
  });

  it('不明な軸 / セルは null', () => {
    const { s, axis } = buildAxisSession();
    expect(s.pullCellToWorking('no-axis', 'cellA')).toBe(null);
    expect(s.pullCellToWorking(axis.id, 'no-cell')).toBe(null);
  });
});

describe('Variants: レイヤー構造が壊れても安全に劣化', () => {
  it('slot フォルダを削除しても各操作はクラッシュせず no-op/空に劣化（文書は replay 整合）', () => {
    const { s, axis } = buildAxisSession(); // base + slot{cellA,cellB,cellC} + 軸
    // slot ごと削除（cell も消える）。base が残るので削除は許可される。
    s.apply(createRemoveLayerOp('slot'));
    expect(getNode(s.state, 'slot')).toBeUndefined();
    expect(getNode(s.state, 'cellA')).toBeUndefined();

    // 各操作が落ちず、妥当に劣化する。
    expect(s.toggleCell(axis.id, 'cellA')).toBe(false); // 死んだセル → no-op
    expect(s.pullCellToWorking(axis.id, 'cellA')).toBe(null);
    expect(s.parkSlot(axis.id)).toBe(false); // slot 無し
    const rev = s.commitRevision('x');
    expect(s.addRevisionAsCell(axis.id, rev)).toBe(false); // slot がフォルダでない
    // プレビュー計算もクラッシュしない。
    expect(() => cellPreviewState(s.state, axis, 'cellA')).not.toThrow();
    expect(() => onionSkinState(s.state, axis)).not.toThrow();

    // 同期すると死んだセルは落ちる（slot 無し → 空）。
    s.syncAxisCells(axis.id);
    expect(s.getAxis(axis.id)!.cells.length).toBe(0);

    // axes はサイドカーで log/state に影響しないので、文書は replay 整合のまま。
    expect(statesEqual(s.state, replay(s))).toBe(true);
  });

  it('セルを slot の外へ出してもクラッシュせず、同期で軸から外れる', () => {
    const { s, axis } = buildAxisSession();
    s.apply(createMoveNodeOp('cellB', null, 0)); // cellB を最上位へ（slot の外）
    expect(getNode(s.state, 'cellB')).toBeDefined(); // ノード自体は存命
    s.syncAxisCells(axis.id);
    expect(s.getAxis(axis.id)!.cells.map((c) => c.id)).toEqual(['cellA', 'cellC']);
    expect(statesEqual(s.state, replay(s))).toBe(true);
  });
});

describe('Variants: 選択式(slotless)軸（フォルダ不要）', () => {
  const P = { color: [10, 10, 10] as [number, number, number], size: 4, opacity: 1 };

  it('addAxisFromLayers: 任意のレイヤーをフォルダなしでセルにする（存在しない id は除外）', () => {
    const s = new EditorSession(W, H);
    for (const id of ['L1', 'L2', 'L3']) s.apply(createAddLayerOp(id, id, W, H));
    const axis = s.addAxisFromLayers('表情', ['L1', 'L2', 'L3', 'nope']);
    expect(axis.slotId).toBeUndefined();
    expect(axis.cells.map((c) => c.id)).toEqual(['L1', 'L2', 'L3']); // nope は除外

    // トグルが効き、replay 整合。
    expect(s.toggleCell(axis.id, 'L2')).toBe(true);
    expect(getNode(s.state, 'L2')!.visible).toBe(false);
    expect(statesEqual(s.state, replay(s))).toBe(true);
  });

  it('slotless では sync/park は no-op、preview/onion は動く', () => {
    const s = new EditorSession(W, H);
    s.apply(createAddLayerOp('L1', 'L1', W, H));
    s.apply(createAddLayerOp('L2', 'L2', W, H));
    const axis = s.addAxisFromLayers('a', ['L1', 'L2']);
    expect(s.syncAxisCells(axis.id)).toBe(false); // 同期対象フォルダ無し
    expect(s.parkSlot(axis.id)).toBe(false); // 退避領域無し
    const pv = cellPreviewState(s.state, axis, 'L1'); // L1 だけ可視
    expect(getNode(pv, 'L1')!.visible).toBe(true);
    expect(getNode(pv, 'L2')!.visible).toBe(false);
    expect(() => onionSkinState(s.state, axis)).not.toThrow();
  });

  it('slotless に addRevisionAsCell すると最上位に取り込みセル化（replay 整合）', () => {
    const s = new EditorSession(W, H);
    s.apply(createAddLayerOp('L1', 'L1', W, H));
    const axis = s.addAxisFromLayers('a', ['L1']);
    s.apply(createBrushOp('L1', line(2, 2, 12, 12, 5), P, W, H));
    const rev = s.commitRevision('v1');

    expect(s.addRevisionAsCell(axis.id, rev)).toBe(true);
    const cells = s.getAxis(axis.id)!.cells;
    expect(cells.length).toBe(2);
    const added = cells[cells.length - 1];
    expect(added.sourceRevId).toBe(rev.id);
    expect(getNode(s.state, added.id)!.visible).toBe(false); // 初期は非表示
    expect(statesEqual(s.state, replay(s))).toBe(true);
  });
});
