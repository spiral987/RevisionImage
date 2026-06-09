import { useEffect, useMemo, useRef, useState } from 'react';
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

export function App() {
  const W = 640;
  const H = 480;

  const sessionRef = useRef<EditorSession | null>(null);
  if (!sessionRef.current) sessionRef.current = new EditorSession(W, H);
  const session = sessionRef.current;

  const [version, setVersion] = useState(0);
  const [revisions, setRevisions] = useState<CommittedRevision[]>([]);
  const [selectedRevIds, setSelectedRevIds] = useState<string[]>([]);
  const [diffPair, setDiffPair] = useState<[CommittedRevision, CommittedRevision] | null>(null);
  const [mergePair, setMergePair] = useState<[CommittedRevision, CommittedRevision] | null>(null);
  const [commitLabel, setCommitLabel] = useState('');
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
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
    serializeProject({ width: W, height: H, log: session.getLog(), revisions: session.revisions });

  // 起動時に IndexedDB から復元（リロード後もプロジェクトが復元される）。
  useEffect(() => {
    if (loadedRef.current) return;
    loadedRef.current = true;
    loadFromIndexedDB()
      .then((p) => {
        if (p && (p.log.length > 0 || p.revisions.length > 0)) {
          session.loadProject(p);
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
        setRevisions([...session.revisions]);
        setSelectedRevIds([]);
        setSelectedNodeId(null);
        setDiffPair(null);
        setMergePair(null);
        setVersion((v) => v + 1);
      })
      .catch(() => alert('JSON の読み込みに失敗しました。'));
  };

  const dag = useMemo(() => session.getDag(), [version, session]);

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
      <header className="app-header">
        <h1>Nonlinear Revision Control for Images</h1>
        <p className="subtitle">Phase 7 — 永続化 &amp; 多重解像度 RevG</p>
      </header>

      <div className="workspace">
        <CanvasEditor
          session={session}
          width={W}
          height={H}
          version={version}
          dag={dag}
          onEdit={onEdit}
          highlightRegion={selectedRegion}
          onRegionSelect={onCanvasRegionSelect}
        />
      </div>

      <section className="revisions-bar">
        <h2>
          Revisions{' '}
          <span className="save-indicator">{saved ? '✓ 自動保存済み' : ''}</span>
        </h2>
        <div className="rev-commit">
          <button onClick={exportJson}>Export JSON</button>
          <button onClick={() => fileInputRef.current?.click()}>Import JSON</button>
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
          <span className="rev-sep" />
        </div>
        <div className="rev-commit">
          <input
            type="text"
            placeholder="ラベル（任意）"
            value={commitLabel}
            onChange={(e) => setCommitLabel(e.target.value)}
          />
          <button onClick={commit} disabled={session.getLog().length === 0}>
            Commit current
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
            「Commit current」で現在の状態をリビジョンとして確定。過去リビジョンを Checkout すると
            そこから分岐して編集でき、2つ選んで Compare（差分）/ Merge（統合）できます。
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
      </section>

      <section className="revg-section">
        <h2>RevG（リビジョングラフ）</h2>
        <p className="hint">
          ノードクリックで対応領域をキャンバスにハイライト。select ツールでキャンバスの領域を選ぶと
          対応ノードを強調。枠色は操作クラス（brush=赤 / color=青 / rigid=緑 / deform=黄 / edit=紫）。
        </p>
        <RevGView
          session={session}
          dag={dag}
          version={version}
          selectedNodeId={selectedNodeId}
          onSelectNode={setSelectedNodeId}
        />
      </section>

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
