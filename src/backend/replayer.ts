import type { EditorState, Operation, ImageBuffer } from '../types';
import { createInitialState } from '../engine/editorState';
import { applyOperation } from '../engine/operation';
import { flattenState, type FlattenOptions } from '../engine/composite';
import '../engine/operations'; // 操作ハンドラの登録を保証

/**
 * Replayer（SPEC §7, Phase 2）。
 * ルート（空キャンバス。将来は「画像ロード」操作）から操作ログを順に applyOperation して
 * 状態を再構築する。画像そのものを保存せず操作だけから状態を復元する論文の核を担う。
 *
 * 戻り値は純TSの EditorState / ImageBuffer（SPEC の ImageData ではなく DOM 非依存型）。
 * UI 側で `new ImageData(buffer.data, w, h)` に変換して表示・サムネイル化する。
 */
export class Replayer {
  constructor(
    public readonly width: number,
    public readonly height: number,
  ) {}

  private root(custom?: EditorState): EditorState {
    return custom ?? createInitialState(this.width, this.height);
  }

  /**
   * log の先頭から upTo 個の操作を適用した状態を返す。
   * upTo を省略すると全操作を適用。範囲外の upTo は [0, log.length] にクランプ。
   * upTo=0 はルート状態（操作適用前）。
   */
  replay(log: readonly Operation[], upTo?: number, root?: EditorState): EditorState {
    const n = upTo == null ? log.length : Math.max(0, Math.min(Math.floor(upTo), log.length));
    let s = this.root(root);
    for (let i = 0; i < n; i++) {
      s = applyOperation(s, log[i]);
    }
    return s;
  }

  /**
   * [root, after#1, ..., after#N] を1パスで返す（サムネイル一括生成用）。
   * applyOperation は変更レイヤのみ複製するため、各状態は未変更レイヤを構造共有し
   * メモリ効率が良い。返り値の長さは log.length + 1。
   */
  replayAll(log: readonly Operation[], root?: EditorState): EditorState[] {
    const states: EditorState[] = [];
    let s = this.root(root);
    states.push(s);
    for (let i = 0; i < log.length; i++) {
      s = applyOperation(s, log[i]);
      states.push(s);
    }
    return states;
  }

  /** upTo 個適用後の状態を1枚のRGBA画像に合成して返す（ImageData 相当の純TS表現）。 */
  replayToImage(
    log: readonly Operation[],
    upTo?: number,
    opts?: FlattenOptions,
    root?: EditorState,
  ): ImageBuffer {
    return flattenState(this.replay(log, upTo, root), opts);
  }
}
