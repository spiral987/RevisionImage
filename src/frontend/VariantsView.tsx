import { useDeferredValue, useMemo, useState } from 'react';
import type { EditorSession } from '../session';
import { flattenState } from '../engine/composite';
import { getNode } from '../engine/editorState';
import { cellPreviewState, listGroups } from '../backend/variant';
import { bufferToDataURL } from './thumbnail';

const THUMB_W = 72;
const THUMB_H = 54;

/**
 * 空間の読み（差分制作 / Variants）UI（CONCEPT §3.3 層1 の空間UI）。
 * 行＝軸、列＝セルのサムネイル行列で「対等な別案」を読む。フラットなレイヤーリスト
 * （Layer Comp の反面教師）でなく、差し替え点(slot)ごとに束ねて見せる。
 * セル選択は session.selectCell（= setLayerVisibility op）に落ちるので版に焼ける。
 */
export function VariantsView({
  session,
  version,
  onEdit,
  onActivateLayer,
}: {
  session: EditorSession;
  version: number;
  onEdit: () => void;
  /** pull（セル→作業）でアクティブにすべきリーフ layer id を App 経由で CanvasEditor へ伝える。 */
  onActivateLayer: (layerId: string) => void;
}) {
  const deferred = useDeferredValue(version);
  const [name, setName] = useState('');
  const [slotId, setSlotId] = useState('');

  const groups = listGroups(session.state);

  // 各セルのサムネ（base + そのセルだけ＝合成文脈込み）。編集に追従するよう deferred で再計算。
  const thumbs = useMemo(() => {
    const m = new Map<string, string>();
    for (const axis of session.axes) {
      for (const cell of axis.cells) {
        const st = cellPreviewState(session.state, axis, cell.id);
        m.set(`${axis.id}:${cell.id}`, bufferToDataURL(flattenState(st), THUMB_W, THUMB_H));
      }
    }
    return m;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deferred]);

  const createAxis = () => {
    if (!slotId) return;
    const axis = session.addAxis(name, slotId);
    session.syncAxisCells(axis.id); // slot 直下の子を初期セルに取り込む
    setName('');
    onEdit();
  };

  return (
    <div className="variants">
      {/* 新規軸の作成（差し替え点を選ぶ） */}
      <div className="var-new">
        <input
          type="text"
          placeholder="軸の名前（例: 目）"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <select value={slotId} onChange={(e) => setSlotId(e.target.value)}>
          <option value="">差し替え点（フォルダ）…</option>
          {groups.map((g) => (
            <option key={g.id} value={g.id}>
              {'　'.repeat(g.depth)}
              {g.name}
            </option>
          ))}
        </select>
        <button onClick={createAxis} disabled={!slotId}>
          軸を追加
        </button>
      </div>

      {groups.length === 0 && (
        <p className="hint">
          差分の差し替え点は「フォルダ」で宣言します。まずレイヤーをフォルダにまとめて、その中に
          別案レイヤーを入れてください。
        </p>
      )}

      {session.axes.length === 0 ? (
        <p className="hint">
          軸はまだありません。別案を入れたフォルダを差し替え点に選んで「軸を追加」すると、フォルダ内の
          レイヤーが別案セルとして並びます。択一＝1つだけ表示、トグル＝各々を独立に on/off。
        </p>
      ) : (
        <div className="var-axes">
          {session.axes.map((axis) => {
            const slotName = getNode(session.state, axis.slotId)?.name ?? '(失われた slot)';
            return (
              <div className="var-axis" key={axis.id}>
                <div className="var-axis-head">
                  <span className="var-axis-name">{axis.name}</span>
                  <span className="muted">· {slotName}</span>
                  <span className="var-axis-spacer" />
                  {session.revisions.length > 0 && (
                    <select
                      className="var-addrev"
                      value=""
                      title="過去のコミットを別案セルとして取り込む（時間→空間の昇格）"
                      onChange={(e) => {
                        const rev = session.revisions.find((r) => r.id === e.target.value);
                        if (rev) {
                          session.addRevisionAsCell(axis.id, rev);
                          onEdit();
                        }
                        e.currentTarget.value = '';
                      }}
                    >
                      <option value="">＋版から…</option>
                      {session.revisions.map((r, i) => (
                        <option key={r.id} value={r.id}>
                          #{i} {r.label}
                        </option>
                      ))}
                    </select>
                  )}
                  <button
                    title="現在の見た目を別案セルへ退避し、作業ビューをクリア（非破壊・引き戻し可）"
                    onClick={() => {
                      session.parkSlot(axis.id);
                      onEdit();
                    }}
                  >
                    ⇩ 退避
                  </button>
                  <button
                    title="slot フォルダの中身とセルを同期する"
                    onClick={() => {
                      session.syncAxisCells(axis.id);
                      onEdit();
                    }}
                  >
                    ⟲ 同期
                  </button>
                  <button
                    title="この軸（読み方）を削除。レイヤー自体は消えません。"
                    onClick={() => {
                      session.removeAxis(axis.id);
                      onEdit();
                    }}
                  >
                    ✕
                  </button>
                </div>

                {axis.cells.length === 0 ? (
                  <p className="hint">
                    このフォルダにはまだ別案レイヤーがありません。フォルダ内にレイヤーを足して「同期」を
                    押してください。
                  </p>
                ) : (
                  <div className="var-cells">
                    {axis.cells.map((cell) => {
                      const node = getNode(session.state, cell.id);
                      const on = !!node?.visible;
                      return (
                        <div
                          key={cell.id}
                          className={`var-cell ${on ? 'on' : ''}`}
                          title={cell.sourceRevId ? `${cell.name}（過去版由来）` : cell.name}
                          onClick={() => {
                            session.toggleCell(axis.id, cell.id);
                            onEdit();
                          }}
                        >
                          <img
                            className="var-cell-thumb"
                            src={thumbs.get(`${axis.id}:${cell.id}`)}
                            alt={cell.name}
                          />
                          <div className="var-cell-name">
                            <span className="var-cell-mark">{on ? '☑' : '☐'}</span>
                            <span className="var-cell-label">{cell.name}</span>
                            {cell.sourceRevId && (
                              <span className="var-cell-src" title="過去版由来">
                                ⤴
                              </span>
                            )}
                            <button
                              className="var-cell-edit"
                              title="このセルを作業対象として編集（pull）"
                              onClick={(e) => {
                                e.stopPropagation();
                                const leaf = session.pullCellToWorking(axis.id, cell.id);
                                onEdit();
                                if (leaf) onActivateLayer(leaf);
                              }}
                            >
                              ✎
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
