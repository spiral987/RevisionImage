import { useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import type { EditorSession } from '../session';
import { flattenState } from '../engine/composite';
import { getNode } from '../engine/editorState';
import { isGroup } from '../engine/layer';
import { cellPreviewState, listGroups, onionSkinState } from '../backend/variant';
import { bufferToDataURL } from './thumbnail';
import { ThumbCard } from './ThumbCard';
import { PopoverMenu, type MenuItem } from './Popover';

const THUMB_W = 128;
const THUMB_H = 96;
const CARD = 100; // セルカードのサムネ表示幅
const ONION_W = 240;
const ONION_H = 170;

/**
 * 空間の読み（差分制作 / Variants）UI。Quickpose 流「サムネ第一」棚。
 * 1 軸＝大きいサムネカード（ThumbCard）の横一列の棚。カードクリックで表示トグル、
 * 名前はインライン改名、稀な操作（pull/出自ナビ/外す/同期/退避/版から取り込み）はホバー or ⋯ に畳む。
 * セル切替は session.toggleCell（= setLayerVisibility op）に落ちるので版に焼ける。
 */
export function VariantsView({
  session,
  version,
  onEdit,
  onActivateLayer,
  onShowRevision,
}: {
  session: EditorSession;
  version: number;
  onEdit: () => void;
  /** pull（セル→作業）でアクティブにすべきリーフ layer id を App 経由で CanvasEditor へ伝える。 */
  onActivateLayer: (layerId: string) => void;
  /** 空間→時間の相互ナビ: 出自リビジョンを Revisions（時間の読み）で選択させる。 */
  onShowRevision: (revId: string) => void;
}) {
  const deferred = useDeferredValue(version);
  const [name, setName] = useState('');
  const [slotId, setSlotId] = useState('');
  // オニオンスキン（重ね表示）を有効にしている軸 id の集合。
  const [onionAxes, setOnionAxes] = useState<Set<string>>(new Set());
  // 「＋版から取り込み」のリビジョン選択を開いている軸 id。
  const [pickRevAxis, setPickRevAxis] = useState<string | null>(null);
  // インライン改名中の軸 id。
  const [editAxis, setEditAxis] = useState<string | null>(null);
  const [axisDraft, setAxisDraft] = useState('');
  const axisInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editAxis && axisInputRef.current) {
      axisInputRef.current.focus();
      axisInputRef.current.select();
    }
  }, [editAxis]);

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

  // オニオンスキンのプレビュー（軸ごと、有効時のみ）。全別案を重ね、隠れたセルを ghost 表示。
  const onionKey = [...onionAxes].sort().join(',');
  const onionThumbs = useMemo(() => {
    const m = new Map<string, string>();
    for (const axis of session.axes) {
      if (!onionAxes.has(axis.id)) continue;
      const st = onionSkinState(session.state, axis);
      m.set(axis.id, bufferToDataURL(flattenState(st), ONION_W, ONION_H));
    }
    return m;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deferred, onionKey]);

  const toggleOnion = (axisId: string) => {
    setOnionAxes((prev) => {
      const next = new Set(prev);
      next.has(axisId) ? next.delete(axisId) : next.add(axisId);
      return next;
    });
  };

  const createAxis = () => {
    if (!slotId) return;
    const axis = session.addAxis(name, slotId);
    session.syncAxisCells(axis.id); // slot 直下の子を初期セルに取り込む
    setName('');
    setSlotId('');
    onEdit();
  };

  const commitAxisName = (axisId: string) => {
    setEditAxis(null);
    session.renameAxis(axisId, axisDraft);
    onEdit();
  };

  return (
    <div className="variants">
      <p className="hint">
        レイヤーパネルで別案レイヤーを選び（Ctrl/⌘+クリックで複数）「→ Variants」で軸を作るのが簡単です
        （フォルダ不要）。フォルダ単位でまとめたい時は下から差し替え点フォルダを選んでも作れます。
      </p>
      {/* フォルダから軸を作る（任意）。差し替え点フォルダの子をセルにする。 */}
      <div className="var-new">
        <input
          type="text"
          placeholder="軸の名前（任意）"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <select value={slotId} onChange={(e) => setSlotId(e.target.value)}>
          <option value="">フォルダから作る…</option>
          {groups.map((g) => (
            <option key={g.id} value={g.id}>
              {'　'.repeat(g.depth)}
              {g.name}
            </option>
          ))}
        </select>
        <button onClick={createAxis} disabled={!slotId}>
          追加
        </button>
      </div>

      {session.axes.length === 0 ? (
        <p className="hint">
          軸はまだありません。各セルは独立にトグル（表示/非表示）できます。
        </p>
      ) : (
        <div className="var-axes">
          {session.axes.map((axis) => {
            const isSlotless = !axis.slotId;
            const slotNode = axis.slotId ? getNode(session.state, axis.slotId) : undefined;
            const slotBroken = !isSlotless && (!slotNode || !isGroup(slotNode));

            // 軸ヘッダの ⋯ メニュー: 稀な操作を畳む。
            const menu: MenuItem[] = [];
            if (session.revisions.length > 0) {
              menu.push({
                label: '＋ 版から取り込み…',
                title: '過去のコミットを別案セルとして取り込む（時間→空間の昇格）',
                onClick: () => setPickRevAxis((a) => (a === axis.id ? null : axis.id)),
              });
            }
            if (!isSlotless) {
              menu.push({
                label: '⟲ フォルダと同期',
                title: 'slot フォルダの中身とセルを同期する',
                onClick: () => {
                  session.syncAxisCells(axis.id);
                  onEdit();
                },
              });
              menu.push({
                label: '⇩ 現在を退避',
                title: '現在の見た目を別案セルへ退避し、作業ビューをクリア（非破壊・引き戻し可）',
                onClick: () => {
                  session.parkSlot(axis.id);
                  onEdit();
                },
              });
            }
            menu.push({
              label: '✕ この軸を削除',
              title: 'この軸（読み方）を削除。レイヤー自体は消えません。',
              danger: true,
              onClick: () => {
                session.removeAxis(axis.id);
                onEdit();
              },
            });

            return (
              <div className="var-axis" key={axis.id}>
                <div className="var-axis-head">
                  {editAxis === axis.id ? (
                    <input
                      ref={axisInputRef}
                      className="var-axis-name-input"
                      value={axisDraft}
                      onChange={(e) => setAxisDraft(e.target.value)}
                      onBlur={() => commitAxisName(axis.id)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') commitAxisName(axis.id);
                        else if (e.key === 'Escape') setEditAxis(null);
                      }}
                    />
                  ) : (
                    <span
                      className="var-axis-name"
                      title="クリックで軸名を変更"
                      onClick={() => {
                        setAxisDraft(axis.name);
                        setEditAxis(axis.id);
                      }}
                    >
                      {axis.name}
                    </span>
                  )}
                  <span className={`muted var-axis-slot ${slotBroken ? 'var-broken' : ''}`}>
                    {isSlotless ? 'レイヤー選択' : slotBroken ? '⚠ 差し替え点なし' : slotNode!.name}
                  </span>
                  <span className="var-axis-spacer" />
                  <button
                    className={`var-icon ${onionAxes.has(axis.id) ? 'on' : ''}`}
                    title="オニオンスキン: 全別案を重ねて表示（隠れた案は薄く）。プレビューのみ。"
                    onClick={() => toggleOnion(axis.id)}
                  >
                    👁
                  </button>
                  <PopoverMenu items={menu} title="この軸の操作" className="var-icon" />
                </div>

                {/* ＋版から取り込み: ⋯ から開いたときだけ出すリビジョン選択。 */}
                {pickRevAxis === axis.id && session.revisions.length > 0 && (
                  <div className="var-pickrev">
                    <select
                      value=""
                      autoFocus
                      onChange={(e) => {
                        const rev = session.revisions.find((r) => r.id === e.target.value);
                        if (rev) {
                          session.addRevisionAsCell(axis.id, rev);
                          onEdit();
                        }
                        setPickRevAxis(null);
                      }}
                    >
                      <option value="">版を選んでセル化…</option>
                      {session.revisions.map((r, i) => (
                        <option key={r.id} value={r.id}>
                          #{i} {r.label}
                        </option>
                      ))}
                    </select>
                    <button onClick={() => setPickRevAxis(null)}>取消</button>
                  </div>
                )}

                {slotBroken && (
                  <p className="hint var-broken">
                    差し替え点フォルダが見つかりません（移動・削除された可能性）。この軸は機能しません。
                    フォルダを作り直すか、⋯ →「この軸を削除」で外してください。
                  </p>
                )}

                {axis.cells.length === 0 ? (
                  !slotBroken && (
                    <p className="hint">
                      {isSlotless
                        ? 'セルがありません。⋯ →「この軸を削除」で外せます。'
                        : 'このフォルダにはまだ別案レイヤーがありません。フォルダ内にレイヤーを足して ⋯ →「同期」を押してください。'}
                    </p>
                  )
                ) : (
                  <div className="var-shelf">
                    {axis.cells.map((cell) => {
                      const node = getNode(session.state, cell.id);
                      const dead = !node; // レイヤーが見つからない（削除/構造破壊）
                      const on = !!node?.visible;
                      const srcLive =
                        cell.sourceRevId && session.revisions.some((r) => r.id === cell.sourceRevId);
                      return (
                        <ThumbCard
                          key={cell.id}
                          thumb={thumbs.get(`${axis.id}:${cell.id}`)}
                          title={cell.name}
                          state={on ? 'current' : 'normal'}
                          dead={dead}
                          size={CARD}
                          badge={dead ? '⚠' : on ? '☑' : '☐'}
                          hint={
                            cell.sourceRevId ? (
                              <span className="var-src-mark" title="過去版由来">
                                ◷
                              </span>
                            ) : undefined
                          }
                          onActivate={() => {
                            session.toggleCell(axis.id, cell.id);
                            onEdit();
                          }}
                          onRename={
                            dead
                              ? undefined
                              : (n) => {
                                  session.renameCell(axis.id, cell.id, n);
                                  onEdit();
                                }
                          }
                          hoverActions={
                            <>
                              {!dead && (
                                <button
                                  className="tc-act"
                                  title="このセルを作業対象として編集（pull）"
                                  onClick={() => {
                                    const leaf = session.pullCellToWorking(axis.id, cell.id);
                                    onEdit();
                                    if (leaf) onActivateLayer(leaf);
                                  }}
                                >
                                  ✎
                                </button>
                              )}
                              {srcLive && (
                                <button
                                  className="tc-act"
                                  title="出自の版を Revisions（時間の読み）で選択"
                                  onClick={() => onShowRevision(cell.sourceRevId!)}
                                >
                                  ⤴
                                </button>
                              )}
                              <button
                                className="tc-act danger"
                                title="このセルを軸から外す（レイヤーは消えません）"
                                onClick={() => {
                                  session.removeCell(axis.id, cell.id);
                                  onEdit();
                                }}
                              >
                                ✕
                              </button>
                            </>
                          }
                        />
                      );
                    })}
                  </div>
                )}

                {onionAxes.has(axis.id) && axis.cells.length > 0 && (
                  <div className="var-onion">
                    <img src={onionThumbs.get(axis.id)} alt="オニオンスキン" />
                    <span className="hint">重ね表示（表示中＝濃い / 隠れ＝薄い）。プレビューのみ。</span>
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
