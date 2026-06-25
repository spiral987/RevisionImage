import { useEffect, useMemo, useRef, useState } from 'react';
import type { BBox, Operation } from '../types';
import { EditorSession } from '../session';
import { ROOT_ID, createDag } from '../backend/dag';
import { bboxIntersect } from '../backend/dependency';
import type { CommittedRevision } from '../backend/revision';
import {
  serializeProject,
  saveToIndexedDB,
  loadFromIndexedDB,
  isProjectJSON,
} from '../backend/repository';
import { CanvasEditor } from './CanvasEditor';
import { DiffView } from './DiffView';
import { MergeView } from './MergeView';
import { BoardView } from './BoardView';
import { RevGView } from './RevGView';
import { DebugView } from './DebugView';
import { FloatWindow, Section } from './Float';

const SIZE_PRESETS: [number, number][] = [
  [640, 480],
  [800, 600],
  [1024, 768],
  [1280, 720],
];

export function App() {
  const sessionRef = useRef<EditorSession | null>(null);
  if (!sessionRef.current) sessionRef.current = new EditorSession(800, 600);
  const session = sessionRef.current;

  const [version, setVersion] = useState(0);
  const [dims, setDims] = useState({ w: session.width, h: session.height });
  const [wInput, setWInput] = useState(String(session.width));
  const [hInput, setHInput] = useState(String(session.height));
  const [revisions, setRevisions] = useState<CommittedRevision[]>([]);
  const [diffPair, setDiffPair] = useState<[CommittedRevision, CommittedRevision] | null>(null);
  const [mergePair, setMergePair] = useState<[CommittedRevision, CommittedRevision] | null>(null);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  // RevG（解像度つき統合グラフ）ウインドウの展開状態。常時マウントしサムネキャッシュを温存し、
  // active で重い集約/レイアウトだけ切り替える。
  const [revgOpen, setRevgOpen] = useState(true);
  // Board ウインドウの展開状態。RevG と同じく常時マウント＋active 切り替えで、閉じれば描画中の
  // サムネ合成・カード再描画を 0 にできる（サムネキャッシュは温存）。
  const [boardOpen, setBoardOpen] = useState(true);
  const [saved, setSaved] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const psdInputRef = useRef<HTMLInputElement>(null);
  const loadedRef = useRef(false);

  const onEdit = () => {
    setVersion((v) => v + 1);
    setRevisions([...session.revisions]);
    if (session.revisions.length === 0) {
      setDiffPair(null);
      setMergePair(null);
    }
  };

  const snapshot = () =>
    serializeProject({
      width: session.width,
      height: session.height,
      log: session.getLog(),
      revisions: session.revisions,
      boardLayout: session.boardLayout,
    });

  // 時間の読み: 過去の版と「現在の作業状態」を見比べる（CONCEPT §2-4「過去と現在を見比べたい」）。
  // 現在の作業ログから合成リビジョンを作り、既存 DiffView にそのまま流す（DiffView は label/ops のみ使う）。
  const compareWithCurrent = (rev: CommittedRevision) => {
    const current: CommittedRevision = {
      id: 'current',
      label: '現在（作業中）',
      headIds: [],
      ops: [...session.getLog()],
      timestamp: Date.now(),
    };
    setDiffPair([rev, current]);
  };

  // 読み込み後に dims / 入力欄をセッションへ同期する。
  const syncDims = () => {
    setDims({ w: session.width, h: session.height });
    setWInput(String(session.width));
    setHInput(String(session.height));
  };

  // キャンバスサイズ変更（ログは保持、内容は左上基準で保たれる）。
  const applyCanvasSize = (w: number, h: number) => {
    const cw = Math.max(16, Math.min(4096, Math.round(w)));
    const ch = Math.max(16, Math.min(4096, Math.round(h)));
    if (cw === session.width && ch === session.height) return;
    session.resize(cw, ch);
    setDims({ w: cw, h: ch });
    setWInput(String(cw));
    setHInput(String(ch));
    setSelectedNodeId(null);
    setVersion((v) => v + 1);
  };

  // 起動時に IndexedDB から復元（リロード後もプロジェクトが復元される）。
  useEffect(() => {
    if (loadedRef.current) return;
    loadedRef.current = true;
    loadFromIndexedDB()
      .then((p) => {
        if (p && (p.log.length > 0 || p.revisions.length > 0)) {
          session.loadProject(p);
          syncDims();
          setRevisions([...session.revisions]);
          setVersion((v) => v + 1);
        }
      })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 編集/コミットのたびに IndexedDB へ自動保存（デバウンス）。
  useEffect(() => {
    const t = setTimeout(() => {
      saveToIndexedDB(snapshot())
        .then(() => {
          setSaved(true);
          setTimeout(() => setSaved(false), 1200);
        })
        .catch(() => {});
    }, 500);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version, revisions]);

  const exportJson = () => {
    const blob = new Blob([JSON.stringify(snapshot(), null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'project.nrc.json';
    a.click();
    URL.revokeObjectURL(url);
  };

  const importJson = (file: File) => {
    file
      .text()
      .then((t) => {
        const parsed = JSON.parse(t);
        if (!isProjectJSON(parsed)) {
          alert('対応していない JSON です（format: nrc-images ではありません）。');
          return;
        }
        session.loadProject(parsed);
        syncDims();
        setRevisions([...session.revisions]);
        setSelectedNodeId(null);
        setDiffPair(null);
        setMergePair(null);
        setVersion((v) => v + 1);
      })
      .catch(() => alert('JSON の読み込みに失敗しました。'));
  };

  // PSD を読み込み、レイヤーツリーを操作列として復元する（新規ドキュメントとして開く）。
  // ag-psd は重いので動的 import で必要時のみ読み込む。
  const importPsd = (file: File) => {
    import('./psdImport')
      .then(({ buildOpsFromPsd }) => buildOpsFromPsd(file))
      .then(({ width, height, ops }) => {
        // loadProject が width/height を設定し、ops を初期状態から replay してツリーを再構築する。
        session.loadProject({ width, height, log: ops, revisions: [] });
        syncDims();
        setRevisions([]);
        setSelectedNodeId(null);
        setDiffPair(null);
        setMergePair(null);
        setVersion((v) => v + 1);
      })
      .catch((err) => {
        console.error(err);
        alert('PSD の読み込みに失敗しました。');
      });
  };

  // DAG/RevG の再構築は重い。とくに dagre layout は数百ノードで 1 回 ~350ms かかり、これが
  // 編集ごと（useDeferredValue でも描画の合間に走る）に動くと、履歴が長いほど描画がカクつく真因になる。
  // そこで「最後の編集から少しアイドルしたら進む “落ち着いた版”」を導入し、重いグラフはそのときだけ
  // 作り直す。キャンバス描画は version で即時更新されるため、グラフだけが少し遅れて追従する
  // （RevG/Board はレビュー用途なので、描画バーストを 1 回にまとめて問題ない）。
  const [settledVersion, setSettledVersion] = useState(version);
  useEffect(() => {
    const t = setTimeout(() => setSettledVersion(version), 300);
    return () => clearTimeout(t);
  }, [version]);

  const dag = useMemo(() => session.getDag(), [settledVersion, session]);

  // 統合DAG: 全リビジョン + 作業ログを重ね、分岐/マージを1グラフに表す（統合 RevG の入力）。
  // O(ブランチ数 × ノード²) と重いので、RevG を開いているか・ノード選択中（領域ハイライトに必要）の
  // ときだけ構築する。閉じていて未選択なら誰も参照しないので空 DAG で済ませる。
  const needUnifiedDag = revgOpen || selectedNodeId !== null;
  const unifiedDag = useMemo(
    () => (needUnifiedDag ? session.getUnifiedDag() : createDag(session.width, session.height)),
    [settledVersion, revisions, session, needUnifiedDag],
  );

  // RevG ノードのクリックで領域をハイライトする。統合DAGのノード（分岐側の固有ノードを含む）から引く。
  const selectedRegion = useMemo<BBox | null>(() => {
    if (!selectedNodeId || selectedNodeId === ROOT_ID) return null;
    return unifiedDag.nodes.get(selectedNodeId)?.op.region ?? null;
  }, [selectedNodeId, unifiedDag]);

  const onCanvasRegionSelect = (bbox: BBox) => {
    const log = session.getLog();
    for (let i = log.length - 1; i >= 0; i--) {
      if (bboxIntersect(log[i].region, bbox)) {
        setSelectedNodeId(log[i].id);
        return;
      }
    }
    setSelectedNodeId(null);
  };

  // 現在の作業ログが既存リビジョンのいずれかとして保存済みか（op id 列で判定）。
  const isWorkingSaved = (): boolean => {
    const log = session.getLog();
    return session.revisions.some(
      (r) => r.ops.length === log.length && r.ops.every((o, i) => o.id === log[i].id),
    );
  };

  // checkout / merge など「作業ログを置き換える破壊的操作」の直前に呼ぶ。未保存(=どのリビジョンにも
  // 一致しない)作業があれば、自動でチェックポイント・リビジョンとしてコミットしてから先へ進む。
  // これにより「コミット前の作業が無確認で消える」事態を防ぐ（コミット済みは決して失われない）。
  // 自動保存したら true。
  const autoCheckpointIfDirty = (): boolean => {
    if (session.getLog().length === 0 || isWorkingSaved()) return false;
    session.commitRevision('自動保存（切り替え前）');
    return true;
  };

  const checkout = (rev: CommittedRevision) => {
    autoCheckpointIfDirty(); // 未コミットの作業を失わないよう、切り替え前に自動チェックポイント
    session.checkout(rev.ops);
    setRevisions([...session.revisions]);
    setSelectedNodeId(null);
    setVersion((v) => v + 1);
  };

  // コミット点（リビジョン）の削除。保存済みチェックポイントを消すだけで作業状態は不変。
  // 参照していた選択/比較/マージのペアは解除する。統合 RevG は revisions 変化で再構築される。
  // 実削除（確認なし）。Board は 3 クリック削除ボタンが安全弁なのでこちらを直接呼ぶ。
  const runDeleteRev = (rev: CommittedRevision) => {
    session.deleteRevision(rev.id);
    setRevisions([...session.revisions]);
    setDiffPair((p) => (p && (p[0].id === rev.id || p[1].id === rev.id) ? null : p));
    setMergePair((p) => (p && (p[0].id === rev.id || p[1].id === rev.id) ? null : p));
    setSelectedNodeId(null);
  };

  // 確認つき削除（RevG の ⋯ メニュー用。メニュー項目は 3 クリック化できないので window.confirm）。
  const deleteRev = (rev: CommittedRevision) => {
    const i = revisions.findIndex((r) => r.id === rev.id);
    if (
      !window.confirm(
        `コミット「#${i} ${rev.label}」を削除しますか？\n保存したチェックポイントが消えるだけで、作業中の状態には影響しません。`,
      )
    )
      return;
    runDeleteRev(rev);
  };

  // selective undo（NRCI）: 指定操作と依存する後続を作業ログから除去する。NRCI は履歴(DAG)を消さない
  // 非破壊設計なので、取り消し前の状態を必ずリビジョンとして保存してから実行する（checkout/branch と同じ）。
  // これで外した操作はリビジョンに残り、いつでも checkout/branch で復元・遡行できる。Ctrl/⌘+Z でも即戻せる。
  const doSelectiveUndo = (opIds: string[]) => {
    const drop = session.selectiveUndoTargets(opIds);
    if (drop.size === 0) return;
    if (
      drop.size > opIds.length &&
      !window.confirm(
        `この操作に依存する後続も含め、合計 ${drop.size} 操作を取り消します。\n` +
          `取り消し前の状態は自動保存され（リビジョン化）、Ctrl/⌘+Z でも戻せます。よろしいですか？`,
      )
    )
      return;
    autoCheckpointIfDirty(); // 非破壊: 取り消し前の状態を永続的に残す
    if (!session.selectiveUndo(opIds)) return;
    setRevisions([...session.revisions]); // 自動チェックポイントでリビジョンが増えうる
    setSelectedNodeId(null);
    setVersion((v) => v + 1);
  };

  // RevG の任意ノード/エッジから新しいブランチを始める（その点までを作業ログにして以後の編集を分岐）。
  // checkout(rev) と同じく未コミット作業は自動チェックポイントしてから切り替える。
  const branchFrom = (nodeId: string) => {
    const ops = session.opsUpTo(nodeId);
    if (!ops) return;
    autoCheckpointIfDirty();
    session.checkout(ops);
    setRevisions([...session.revisions]);
    setSelectedNodeId(null);
    setVersion((v) => v + 1);
  };

  const onMerged = (mergedOps: Operation[], label: string) => {
    autoCheckpointIfDirty(); // マージ確定も作業ログを置き換えるので、未コミット作業を先に保存
    session.checkout(mergedOps);
    session.commitRevision(label);
    setRevisions([...session.revisions]);
    setMergePair(null);
    setSelectedNodeId(null);
    setVersion((v) => v + 1);
  };

  return (
    <div className="app">
      <CanvasEditor
        session={session}
        width={dims.w}
        height={dims.h}
        version={version}
        dag={dag}
        onEdit={onEdit}
        highlightRegion={selectedRegion}
        onRegionSelect={onCanvasRegionSelect}
      />

      {/* 上部の細いフロートバー: タイトル + キャンバスサイズ + JSON 入出力 */}
      <div className="float-topbar">
        <span className="app-name">NRC</span>
        <span className="csb-label">Canvas</span>
        <input
          type="number"
          min={16}
          max={4096}
          value={wInput}
          onChange={(e) => setWInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') applyCanvasSize(Number(wInput), Number(hInput));
          }}
        />
        <span className="csb-x">×</span>
        <input
          type="number"
          min={16}
          max={4096}
          value={hInput}
          onChange={(e) => setHInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') applyCanvasSize(Number(wInput), Number(hInput));
          }}
        />
        <button onClick={() => applyCanvasSize(Number(wInput), Number(hInput))}>Resize</button>
        {SIZE_PRESETS.map(([w, h]) => (
          <button
            key={`${w}x${h}`}
            className={w === dims.w && h === dims.h ? 'active' : ''}
            onClick={() => applyCanvasSize(w, h)}
          >
            {w}×{h}
          </button>
        ))}
        <span className="rev-sep" />
        <button onClick={exportJson}>Export JSON</button>
        <button onClick={() => fileInputRef.current?.click()}>Import JSON</button>
        <button onClick={() => psdInputRef.current?.click()} title="PSD を新規ドキュメントとして開く">
          Import PSD
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept="application/json,.json"
          style={{ display: 'none' }}
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) importJson(f);
            e.target.value = '';
          }}
        />
        <input
          ref={psdInputRef}
          type="file"
          accept=".psd,image/vnd.adobe.photoshop"
          style={{ display: 'none' }}
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) importPsd(f);
            e.target.value = '';
          }}
        />
        <span className="save-indicator">{saved ? '✓ 保存済み' : ''}</span>
      </div>

      {/* 盤面(Board): コミットの木（時間=version の系統）。枝分かれ自体が別案（差分）を表す。 */}
      <FloatWindow
        id="nrc-board"
        title="Board"
        defaultPos={{ left: 12, bottom: 12 }}
        className="float-board"
      >
        <section className={`fsec ${boardOpen ? 'open' : 'closed'}`}>
          <div className="fsec-head">
            <button
              className="fsec-toggle"
              onClick={() => setBoardOpen((o) => !o)}
              title={boardOpen ? '折りたたむ' : '展開'}
            >
              {boardOpen ? '−' : '+'}
              <span className="fsec-title">Board</span>
            </button>
          </div>
          <BoardView
            session={session}
            version={settledVersion}
            active={boardOpen}
            onEdit={onEdit}
            onCheckout={(rev) => checkout(rev)}
            onCompareRevisions={(a, b) => setDiffPair([a, b])}
            onMergeRevisions={(a, b) => setMergePair([a, b])}
            onCompareWithCurrent={(rev) => compareWithCurrent(rev)}
            onDeleteRevision={(rev) => runDeleteRev(rev)}
          />
        </section>
      </FloatWindow>

      {/* RevG（解像度つき統合グラフ）: Board とは別ウインドウ。重要度集約のセマンティックズームを残す。 */}
      <FloatWindow id="nrc-revg" title="RevG" defaultPos={{ right: 12, top: 60 }} className="float-revg">
        <section className={`fsec ${revgOpen ? 'open' : 'closed'}`}>
          <div className="fsec-head">
            <button
              className="fsec-toggle"
              onClick={() => setRevgOpen((o) => !o)}
              title={revgOpen ? '折りたたむ' : '展開'}
            >
              {revgOpen ? '−' : '+'}
              <span className="fsec-title">RevG（解像度つき）</span>
            </button>
          </div>
          <div className="fsec-body" style={{ display: revgOpen ? undefined : 'none' }}>
            <p className="hint">
              全リビジョン + 作業中の状態を1つの木に統合。解像度スライダーで重要度集約（セマンティック
              ズーム）。★=コミット, 青枠=今いる場所。カードクリックで対応領域をハイライト、ダブルクリックで
              Checkout、ホバーの ⋯ から比較 / マージ / 削除。
            </p>
          </div>
          <RevGView
            session={session}
            dag={unifiedDag}
            revisions={revisions}
            version={settledVersion}
            active={revgOpen}
            selectedNodeId={selectedNodeId}
            onSelectNode={setSelectedNodeId}
            onCheckoutRevision={(rev) => checkout(rev)}
            onCompareRevisions={(a, b) => setDiffPair([a, b])}
            onMergeRevisions={(a, b) => setMergePair([a, b])}
            onCompareWithCurrent={(rev) => compareWithCurrent(rev)}
            onDeleteRevision={(rev) => deleteRev(rev)}
            onSelectiveUndo={doSelectiveUndo}
            onBranchFrom={branchFrom}
          />
        </section>
      </FloatWindow>

      {/* Debug: バックエンドの規模・負荷指標。既定は折りたたみ（開いた時だけ集計＝負荷ゼロ）。 */}
      <FloatWindow id="nrc-debug" title="Debug" defaultPos={{ right: 12, bottom: 12 }}>
        <Section title="Backend stats" defaultOpen={false}>
          <DebugView session={session} version={version} dag={dag} />
        </Section>
      </FloatWindow>

      {diffPair && (
        <DiffView session={session} revA={diffPair[0]} revB={diffPair[1]} onClose={() => setDiffPair(null)} />
      )}
      {mergePair && (
        <MergeView
          session={session}
          trunk={mergePair[0]}
          branch={mergePair[1]}
          onMerged={onMerged}
          onClose={() => setMergePair(null)}
        />
      )}
    </div>
  );
}
