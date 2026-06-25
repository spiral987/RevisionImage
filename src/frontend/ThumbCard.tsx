import { useEffect, useRef, useState, type ReactNode } from 'react';

export type ThumbCardState = 'normal' | 'current' | 'selected' | 'commit';

/**
 * 「サムネ第一」カード（Quickpose 流）。Variants のセル / Revisions のノードで共有する見た目。
 * 画像が主役・枠色で状態を示し・名前はインライン改名でき・稀な操作はホバーで出す。
 * 振る舞いは props で受け、データモデルには依存しない（純表示部品）。
 */
export function ThumbCard({
  thumb,
  title,
  state = 'normal',
  dead = false,
  size = 96,
  ratio = 0.75,
  badge,
  starred,
  hint,
  onActivate,
  onDoubleClick,
  onRename,
  onToggleStar,
  hoverActions,
  cornerMenu,
  className = '',
}: {
  thumb?: string;
  title: string;
  state?: ThumbCardState;
  /** 参照先レイヤーが見つからない等で機能しないカード。操作不可・破線表示。 */
  dead?: boolean;
  /** サムネ幅(px)。高さは ratio から算出。 */
  size?: number;
  ratio?: number;
  /** 左上の小マーク（☑/☐/⚠ など）。 */
  badge?: ReactNode;
  /** お気に入り。onToggleStar がある時のみ★を表示。 */
  starred?: boolean;
  /** カード下のタイトル横に出す小バッジ（出自など）。 */
  hint?: ReactNode;
  /** カードクリック＝主操作（トグル/切替など）。修飾キー判定用に MouseEvent を渡す。 */
  onActivate?: (e: React.MouseEvent) => void;
  /** ダブルクリック（Revisions の木では「このコミットへ checkout」）。 */
  onDoubleClick?: () => void;
  /** 名前のインライン改名。無ければ名前は読み取り専用。 */
  onRename?: (name: string) => void;
  onToggleStar?: () => void;
  /** ホバーで現れるアイコン操作列（pull/出自ナビ/削除など）。 */
  hoverActions?: ReactNode;
  /** 右下に常設する overflow メニュー等。 */
  cornerMenu?: ReactNode;
  /** 呼び出し側の追加クラス（stacked / pickable など）。 */
  className?: string;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(title);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [editing]);

  const startEdit = (e: React.MouseEvent) => {
    if (!onRename) return;
    e.stopPropagation();
    setDraft(title);
    setEditing(true);
  };
  const commit = () => {
    setEditing(false);
    const next = draft.trim();
    if (next && next !== title) onRename?.(next);
  };

  return (
    <div
      className={`thumb-card ${state} ${dead ? 'dead' : ''} ${className}`}
      style={{ width: size + 8 }}
      onClick={(e) => !dead && onActivate?.(e)}
      onDoubleClick={() => !dead && onDoubleClick?.()}
    >
      <div className="thumb-card-img" style={{ width: size, height: Math.round(size * ratio) }}>
        {thumb && <img src={thumb} alt={title} draggable={false} />}
        {badge != null && <span className="thumb-card-badge">{badge}</span>}
        {onToggleStar && (
          <button
            className={`thumb-card-star ${starred ? 'on' : ''}`}
            title={starred ? 'お気に入り解除' : 'お気に入り'}
            onClick={(e) => {
              e.stopPropagation();
              onToggleStar();
            }}
          >
            {starred ? '★' : '☆'}
          </button>
        )}
        {hoverActions && (
          <div className="thumb-card-hover" onClick={(e) => e.stopPropagation()}>
            {hoverActions}
          </div>
        )}
        {/* cornerMenu はホバーに依存させず常設（ペン/タッチでも届くように）。控えめに置く。 */}
        {cornerMenu && (
          <div className="thumb-card-corner" onClick={(e) => e.stopPropagation()}>
            {cornerMenu}
          </div>
        )}
      </div>

      <div className="thumb-card-name">
        {editing ? (
          <input
            ref={inputRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onClick={(e) => e.stopPropagation()}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commit();
              else if (e.key === 'Escape') setEditing(false);
            }}
          />
        ) : (
          <span
            className={`thumb-card-label ${onRename ? 'editable' : ''}`}
            title={onRename ? `${title}（クリックで改名）` : title}
            onClick={startEdit}
          >
            {title}
          </span>
        )}
        {hint != null && <span className="thumb-card-hint">{hint}</span>}
      </div>
    </div>
  );
}
