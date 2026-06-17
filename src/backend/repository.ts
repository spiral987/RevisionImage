import type { Operation, VariantAxis } from '../types';
import type { CommittedRevision } from './revision';

// 永続化（SPEC §Phase7 / §2）。
// プロジェクト = 操作ログ + リビジョン + 空間軸（DAG は log から決定的に再構築できるので保存不要）。
// シリアライズは純TS（テスト可能）、IndexedDB I/O は browser のみ。

export interface ProjectJSON {
  format: 'nrc-images';
  version: 1;
  width: number;
  height: number;
  log: Operation[];
  revisions: CommittedRevision[];
  /** 空間軸（Variants）。旧バージョンの保存物には無いので optional（読み込み時 [] 既定）。 */
  axes?: VariantAxis[];
}

export interface ProjectData {
  width: number;
  height: number;
  log: readonly Operation[];
  revisions: readonly CommittedRevision[];
  axes?: readonly VariantAxis[];
}

export function serializeProject(data: ProjectData): ProjectJSON {
  return {
    format: 'nrc-images',
    version: 1,
    width: data.width,
    height: data.height,
    log: data.log.map((o) => o),
    revisions: data.revisions.map((r) => ({ ...r, ops: [...r.ops] })),
    axes: (data.axes ?? []).map((a) => ({ ...a, cells: a.cells.map((c) => ({ ...c })) })),
  };
}

/** 受け取った JSON が ProjectJSON として妥当か（最低限）。 */
export function isProjectJSON(x: unknown): x is ProjectJSON {
  const p = x as ProjectJSON | null;
  return (
    !!p &&
    p.format === 'nrc-images' &&
    typeof p.width === 'number' &&
    typeof p.height === 'number' &&
    Array.isArray(p.log) &&
    Array.isArray(p.revisions)
  );
}

// ---- IndexedDB（browser のみ） ----

const DB_NAME = 'nrc-images-db';
const STORE = 'projects';
const CURRENT_KEY = 'current';

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function saveToIndexedDB(json: ProjectJSON, key = CURRENT_KEY): Promise<void> {
  const db = await openDB();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(json, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

export async function loadFromIndexedDB(key = CURRENT_KEY): Promise<ProjectJSON | null> {
  const db = await openDB();
  try {
    return await new Promise<ProjectJSON | null>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      const r = tx.objectStore(STORE).get(key);
      r.onsuccess = () => {
        const v = r.result;
        resolve(isProjectJSON(v) ? v : null);
      };
      r.onerror = () => reject(r.error);
    });
  } finally {
    db.close();
  }
}
