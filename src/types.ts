// ============================================================================
// データモデル（SPEC §5）
// 操作(Operation) / DAG / Revision、およびエンジンの状態(EditorState 等)を定義。
// Backend と Engine は React/DOM に一切依存しない純TSである（SPEC §3）。
// ============================================================================

export type OpClass = 'rigid' | 'deform' | 'color' | 'edit' | 'brush';
// rigid:  translation, rotation
// deform: scale, shear, perspective
// color:  hue, saturation, brightness, contrast, gamma, fill, blur, sharpen
// edit:   copy, paste, anchor, addLayer, layerMask, crop
// brush:  brush, pencil, eraser
// 注: 最初の3クラス(rigid/deform/color)は互いに意味的独立（依存判定で使用）

export interface BBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface StrokePoint {
  x: number;
  y: number;
  pressure: number;
  /**
   * true の点は「ペンダウン＝新しいサブストロークの開始」。直前の点との接続線を引かない。
   * これにより、別々のブラシ操作を1操作に統合(consolidate)しても、操作間に偽の連結線が
   * 生じず「逐次適用 == 統合1回適用」が厳密に成立する。各操作の先頭点に付与される。
   */
  down?: boolean;
}

export interface Operation {
  id: string;
  type: string; // "brush" | "translate" | "hue" など具体名
  klass: OpClass;
  params: Record<string, unknown>;
  region: BBox; // 影響範囲。MVPでは bbox で近似
  layerId: string;
  /** ブラシ系のみ: 点列と筆圧（決定的再生のために記録） */
  strokes?: StrokePoint[];
  /** 乱数を使う操作は必須（決定性確保） */
  seed?: number;
  timestamp: number;
}

// --- DAG（Phase 3 以降で使用） ---------------------------------------------

export interface DagNode {
  id: string; // = Operation.id
  op: Operation;
  parents: string[];
  children: string[];
}

export interface Dag {
  rootId: string; // 初期化操作（空キャンバス or 画像ロード）
  nodes: Map<string, DagNode>;
}

export interface Revision {
  id: string;
  label: string;
  headIds: string[]; // このリビジョンの末端ノード群
  timestamp: number;
}

// --- エンジン状態 -----------------------------------------------------------

/** 生のピクセルバッファ。DOM の ImageData に依存せず純TSで扱える形にする。 */
export interface ImageBuffer {
  width: number;
  height: number;
  data: Uint8ClampedArray; // RGBA, 各値 0..255, 長さ = width*height*4
}

export interface Layer {
  id: string;
  name: string;
  buffer: ImageBuffer;
  /** レイヤ移動(translate)用オフセット。合成時にこの位置へ描画する。 */
  offsetX: number;
  offsetY: number;
  visible: boolean;
  opacity: number; // 0..1
}

/**
 * レイヤーフォルダ（グループ）。子ノード（レイヤー or さらにグループ）を束ねる。
 * 合成時は children を独立バッファに合成してから group の opacity/visible を適用する。
 * buffer を持たない点で Layer と区別される（型ガード isGroup は 'children' の有無で判定）。
 */
export interface LayerGroup {
  id: string;
  name: string;
  visible: boolean;
  opacity: number; // 0..1
  collapsed: boolean; // UI 表示の折りたたみ（描画には影響しない）
  children: LayerNode[];
}

/** レイヤーツリーのノード = リーフ(Layer) または フォルダ(LayerGroup)。 */
export type LayerNode = Layer | LayerGroup;

/** エディタの完全な状態。replay により log から決定的に再構築できる。 */
export interface EditorState {
  width: number;
  height: number;
  layers: LayerNode[]; // 下から上（layers[0] が最背面）。フォルダで階層化される。
  activeLayerId: string;
}
