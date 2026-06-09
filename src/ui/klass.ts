import type { OpClass } from '../types';

// 操作クラスごとの枠色（原論文 Table 1 の border color に対応）。
// styles.css の .op-* と同じ配色を共有し、ログパネルと RevG で一貫させる。
export const KLASS_COLOR: Record<OpClass, string> = {
  rigid: '#6fcf97',
  deform: '#f2c94c',
  color: '#56ccf2',
  edit: '#bb6bd9',
  brush: '#eb5757',
};
