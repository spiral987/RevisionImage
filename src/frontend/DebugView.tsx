import { useMemo, useState, type ReactNode } from 'react';
import type { EditorSession } from '../session';
import type { Dag } from '../types';

/** DAG のエッジ総数（= 全ノードの子リンク数）。 */
function countEdges(d: Dag): number {
  let e = 0;
  for (const n of d.nodes.values()) e += n.children.length;
  return e;
}

/**
 * バックエンドの規模・負荷指標を一覧表示するデバッグ窓。
 * RevG レイアウトや replay が重くなる主因（操作数・ノード/エッジ数・ストローク点数）を可視化する。
 * session.getStats() は DAG を構築せず O(総op) で集計。dag（作業 DAG）は App が常時メモ化済みを受け取る。
 */
export function DebugView({
  session,
  version,
  dag,
}: {
  session: EditorSession;
  version: number;
  dag: Dag;
}) {
  const s = useMemo(() => session.getStats(), [version, session]);
  const dagEdges = useMemo(() => countEdges(dag), [dag]);
  const opTypes = useMemo(
    () => Object.entries(s.opTypeCounts).sort((a, b) => b[1] - a[1]),
    [s],
  );

  // エクスポート用レポート（共有して相談しやすいよう整形 JSON）。表示中の指標＋作業DAGの実ノード/エッジ。
  const json = useMemo(() => {
    const report = {
      exportedAt: new Date().toISOString(),
      canvas: { width: s.width, height: s.height },
      workingLog: {
        ops: s.logOps,
        dagNodes: dag.nodes.size,
        dagEdges,
        strokePoints: s.strokePoints,
        opTypeCounts: s.opTypeCounts,
      },
      storage: { uniqueOps: s.uniqueOps, revisions: s.revisions, revisionOps: s.revisionOps },
      board: { boardEntries: s.boardEntries },
      layers: { leaves: s.layers, groups: s.groups },
      history: { undoDepth: s.undoDepth, redoDepth: s.redoDepth },
    };
    return JSON.stringify(report, null, 2);
  }, [s, dag, dagEdges]);

  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(json);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // クリップボード不可の環境では下のテキストエリアから手動選択でコピーできる。
    }
  };
  const download = () => {
    const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `revimg-debug-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const row = (label: string, value: ReactNode, hint?: string) => (
    <div className="debug-row">
      <span className="debug-label" title={hint}>
        {label}
      </span>
      <span className="debug-value">{value}</span>
    </div>
  );

  return (
    <div className="debug">
      <p className="hint">
        バックエンドの規模・負荷指標。数値が大きいほど RevG レイアウト・replay・サムネ生成が重くなります。
      </p>

      <div className="debug-group">ドキュメント</div>
      {row('キャンバス', `${s.width} × ${s.height}`)}
      {row('レイヤー / フォルダ', `${s.layers} / ${s.groups}`)}

      <div className="debug-group">操作ログ（作業ブランチ）</div>
      {row('操作数 (log)', s.logOps, 'consolidate 後の作業ログの操作数')}
      {row('DAG ノード / エッジ', `${dag.nodes.size} / ${dagEdges}`, '作業ログの依存グラフ（ROOT 含む）')}
      {row('ストローク総点数', s.strokePoints, 'ブラシ/消しゴムの点の総数。ラスタライズ負荷の目安')}

      <div className="debug-group">保存量（全ブランチ）</div>
      {row('総操作（ユニーク）', s.uniqueOps, '作業ログ＋全リビジョンで重複 id を除いた実保存操作数')}
      {row('リビジョン数', s.revisions)}
      {row('リビジョン延べ操作', s.revisionOps, '各リビジョンの ops 合計（共有プレフィックスを含む延べ数）')}

      <div className="debug-group">Board</div>
      {row('Board 配置エントリ', s.boardEntries, '自由配置（サイドカー）の保存数')}

      <div className="debug-group">Undo / Redo</div>
      {row('Undo / Redo 段数', `${s.undoDepth} / ${s.redoDepth}`)}

      <div className="debug-group">操作タイプ内訳（log）</div>
      <div className="debug-optypes">
        {opTypes.length === 0 ? (
          <span className="hint">なし</span>
        ) : (
          opTypes.map(([t, n]) => (
            <span key={t} className="debug-chip">
              {t}: {n}
            </span>
          ))
        )}
      </div>

      <div className="debug-group">エクスポート</div>
      <div className="debug-export">
        <button onClick={copy} title="JSON をクリップボードへコピー（チャットに貼って共有できます）">
          📋 コピー
        </button>
        <button onClick={download} title="JSON ファイルとして保存">
          ⬇ 保存(JSON)
        </button>
        {copied && <span className="debug-copied">コピーしました</span>}
      </div>
      <textarea className="debug-json" value={json} readOnly spellCheck={false} />
    </div>
  );
}
