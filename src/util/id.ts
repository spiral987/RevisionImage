// 一意なID生成。値はログに保存され replay 時はそのまま再利用されるため、
// ピクセル結果には影響しない（決定性に無関係）。

let counter = 0;

export function genId(prefix = 'op'): string {
  try {
    if (typeof globalThis !== 'undefined' && globalThis.crypto?.randomUUID) {
      return `${prefix}_${globalThis.crypto.randomUUID()}`;
    }
  } catch {
    /* fall through */
  }
  counter += 1;
  return `${prefix}_${Date.now().toString(36)}_${counter.toString(36)}`;
}
