import { useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import type { BBox, Operation } from '../types';
import { EditorSession } from '../session';
import { ROOT_ID } from '../backend/dag';
import { bboxIntersect } from '../backend/dependency';
import type { CommittedRevision } from '../backend/revision';
import {
  serializeProject,
  saveToIndexedDB,
  loadFromIndexedDB,
  isProjectJSON,
} from '../backend/repository';
import { CanvasEditor } from './CanvasEditor';
import { RevGView } from './RevGView';
import { DiffView } from './DiffView';
import { MergeView } from './MergeView';
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
  const [selectedRevIds, setSelectedRevIds] = useState<string[]>([]);
  const [diffPair, setDiffPair] = useState<[CommittedRevision, CommittedRevision] | null>(null);
  const [mergePair, setMergePair] = useState<[CommittedRevision, CommittedRevision] | null>(null);
  const [commitLabel, setCommitLabel] = useState('');
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  // REVG の開閉は App 側で持つ。RevGView は常時マウントしたままサムネイルキャッシュを温存し、
  // active で描画/集約だけ切り替える（展開のたびに全ノード再生成して固まるのを防ぐ）。
  const [revgOpen, setRevgOpen] = useState(false);
  const [saved, setSaved] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const psdInputRef = useRef<HTMLInputElement>(null);
  const loadedRef = useRef(false);

  const onEdit = () => {
    setVersion((v) => v + 1);
    setRevisions([...session.revisions]);
    if (session.revisions.length === 0) {
      setSelectedRevIds([]);
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
    });

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
        setSelectedRevIds([]);
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
        setSelectedRevIds([]);
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

  // DAG/RevG の再構築は重い（全ログ replay + 各ノードのサムネイル生成）。version を遅延させ、
  // 描画直後はキャンバス/カーソルを優先し、グラフ更新を低優先度の並行レンダーに回す
  // （ストローク終了直後にカーソルが固まる問題の対策）。
  const deferredVersion = useDeferredValue(version);
  const dag = useMemo(() => session.getDag(), [deferredVersion, session]);

  const selectedRegion = useMemo<BBox | null>(() => {
    if (!selectedNodeId || selectedNodeId === ROOT_ID) return null;
    return dag.nodes.get(selectedNodeId)?.op.region ?? null;
  }, [selectedNodeId, dag]);

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

  const commit = () => {
    session.commitRevision(commitLabel);
    setRevisions([...session.revisions]);
    setCommitLabel('');
  };

  const checkout = (rev: CommittedRevision) => {
    session.checkout(rev.ops);
    setSelectedNodeId(null);
    setVersion((v) => v + 1);
  };

  const toggleRev = (id: string) => {
    setSelectedRevIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : prev.length >= 2 ? [prev[1], id] : [...prev, id],
    );
  };

  const pickPair = (): [CommittedRevision, CommittedRevision] | null => {
    if (selectedRevIds.length !== 2) return null;
    const a = revisions.find((r) => r.id === selectedRevIds[0]);
    const b = revisions.find((r) => r.id === selectedRevIds[1]);
    return a && b ? [a, b] : null;
  };

  const onMerged = (mergedOps: Operation[], label: string) => {
    session.checkout(mergedOps);
    session.commitRevision(label);
    setRevisions([...session.revisions]);
    setMergePair(null);
    setSelectedRevIds([]);
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

      {/* 下部フロートウインドウ: REVISIONS + REVG */}
      <FloatWindow
        id="nrc-bottom"
        title="Revisions / Graph"
        defaultPos={{ left: 12, bottom: 12 }}
        className="float-bottom"
      >
        <Section title="REVISIONS" defaultOpen>
          <div className="rev-commit">
            <input
              type="text"
              placeholder="ラベル（任意）"
              value={commitLabel}
              onChange={(e) => setCommitLabel(e.target.value)}
            />
            <button onClick={commit} disabled={session.getLog().length === 0}>
              Commit
            </button>
            <button onClick={() => setDiffPair(pickPair())} disabled={selectedRevIds.length !== 2}>
              Compare ({selectedRevIds.length}/2)
            </button>
            <button onClick={() => setMergePair(pickPair())} disabled={selectedRevIds.length !== 2}>
              Merge ({selectedRevIds.length}/2)
            </button>
          </div>
          {revisions.length === 0 ? (
            <p className="hint">
              「Commit」で現在の状態をリビジョン確定。過去リビジョンを Checkout すると分岐して編集でき、
              2つ選んで Compare / Merge できます。
            </p>
          ) : (
            <ul className="rev-list">
              {revisions.map((r, i) => (
                <li
                  key={r.id}
                  className={selectedRevIds.includes(r.id) ? 'selected' : ''}
                  onClick={() => toggleRev(r.id)}
                >
                  <span className="rev-check">{selectedRevIds.includes(r.id) ? '☑' : '☐'}</span>
                  <span className="rev-label">
                    #{i} {r.label}
                  </span>
                  <span className="muted">{r.ops.length} ops</span>
                  <button
                    className="rev-checkout"
                    onClick={(e) => {
                      e.stopPropagation();
                      checkout(r);
                    }}
                  >
                    Checkout
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Section>

        {/* REVG は Section で unmount すると展開のたびに全ノードのサムネイルを replay 込みで
            作り直して重い。常時マウントし、active で描画/集約だけ切り替える。 */}
        <section className={`fsec ${revgOpen ? 'open' : 'closed'}`}>
          <div className="fsec-head">
            <button
              className="fsec-toggle"
              onClick={() => setRevgOpen((o) => !o)}
              title={revgOpen ? '折りたたむ' : '展開'}
            >
              {revgOpen ? '−' : '+'}
              <span className="fsec-title">REVG</span>
            </button>
          </div>
          <div className="fsec-body" style={{ display: revgOpen ? undefined : 'none' }}>
            <p className="hint">
              ノードクリックで対応領域をハイライト。枠色は操作クラス（brush=赤 / color=青 / rigid=緑 /
              deform=黄 / edit=紫）。
            </p>
          </div>
          <RevGView
            session={session}
            dag={dag}
            version={deferredVersion}
            active={revgOpen}
            selectedNodeId={selectedNodeId}
            onSelectNode={setSelectedNodeId}
          />
        </section>
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
