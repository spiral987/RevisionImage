import { describe, it, expect } from 'vitest';
import '../src/engine/operations';
import { EditorSession } from '../src/session';
import { BASE_LAYER_ID } from '../src/engine/editorState';
import { Replayer } from '../src/backend/replayer';
import { statesEqual } from '../src/engine/compare';
import { serializeProject, isProjectJSON } from '../src/backend/repository';
import { createBrushOp, createAddLayerOp } from '../src/engine/operations';
import { line } from './helpers';

const W = 64;
const H = 64;
const P = { color: [10, 120, 220] as [number, number, number], size: 8, opacity: 1 };

function buildSession(): EditorSession {
  const s = new EditorSession(W, H);
  s.apply(createBrushOp(BASE_LAYER_ID, line(5, 5, 30, 30, 5), P, W, H));
  s.commitRevision('v1');
  s.apply(createAddLayerOp('layer-2', 'Layer 1', W, H));
  s.apply(createBrushOp('layer-2', line(40, 10, 55, 45, 5), { ...P, color: [220, 60, 10] }, W, H));
  s.commitRevision('v2');
  return s;
}

describe('永続化（シリアライズ往復）', () => {
  it('serializeProject は妥当な ProjectJSON を返す', () => {
    const s = buildSession();
    const json = serializeProject({ width: W, height: H, log: s.getLog(), revisions: s.revisions });
    expect(isProjectJSON(json)).toBe(true);
    expect(json.width).toBe(W);
    expect(json.log.length).toBe(s.getLog().length);
    expect(json.revisions.length).toBe(2);
  });

  it('JSON 文字列を経由しても loadProject で状態・リビジョンが完全復元される', () => {
    const s = buildSession();
    const json = serializeProject({ width: W, height: H, log: s.getLog(), revisions: s.revisions });

    // ファイル保存相当の往復
    const roundTripped = JSON.parse(JSON.stringify(json));
    expect(isProjectJSON(roundTripped)).toBe(true);

    const restored = new EditorSession(W, H);
    restored.loadProject(roundTripped);

    // ライブ状態がビット一致
    expect(statesEqual(restored.state, s.state)).toBe(true);
    // ログ長・リビジョン一致
    expect(restored.getLog().length).toBe(s.getLog().length);
    expect(restored.revisions.map((r) => r.label)).toEqual(['v1', 'v2']);

    // 復元ログを replay してもライブ一致（操作だけから画像復元の核）
    const replayed = new Replayer(W, H).replay(restored.getLog());
    expect(statesEqual(replayed, s.state)).toBe(true);
  });

  it('リビジョンの操作スナップショットも復元される', () => {
    const s = buildSession();
    const json = JSON.parse(
      JSON.stringify(serializeProject({ width: W, height: H, log: s.getLog(), revisions: s.revisions })),
    );
    const restored = new EditorSession(W, H);
    restored.loadProject(json);
    expect(restored.revisions[0].ops.length).toBe(s.revisions[0].ops.length);
    expect(restored.revisions[1].ops.length).toBe(s.revisions[1].ops.length);
  });

  it('不正な JSON は isProjectJSON で弾く', () => {
    expect(isProjectJSON({})).toBe(false);
    expect(isProjectJSON({ format: 'other' })).toBe(false);
    expect(isProjectJSON(null)).toBe(false);
  });
});
