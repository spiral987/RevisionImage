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

// --- 空間軸（差分制作 / Variants） -----------------------------------------
// CONCEPT.md §3.1 の「空間エッジ＝対等な別案」を、既存のレイヤー構造に被せる薄い関係層
// として表す。DAG（操作依存）には入れず、スナップショット集合に対する「読み方」として持つ。
// 詳細・設計の根拠は docs/mds/PLAN.md §2。

/**
 * 軸に属する1つの別案（セル）。実体は slot（差し替え点）配下の兄弟ノード。
 * id はそのノードの id（Layer または LayerGroup）に一致する。セル切替＝この id の
 * 表示/非表示なので、差分切替は既存の setLayerVisibility 操作で決定的に表現できる。
 */
export interface VariantCell {
  id: string; // = slot 配下の兄弟 nodeId（Layer / LayerGroup）
  name: string;
  /** 層2（CONCEPT §3.3）: あるリビジョン由来なら出自を保持する。時間→空間の橋。 */
  sourceRevId?: string;
}

/**
 * 空間軸 ＝ 別案（セル）を束ねる単位（「目」「口」「トップス」…）。
 * 2 通りの作り方がある:
 *  - フォルダ式: slotId にフォルダ(差し替え点)を指定し、その子をセルにする（同期・退避が使える）。
 *  - 選択式(slotless): slotId を持たず、任意の場所のレイヤーを直接セルにする（フォルダ不要）。
 * どちらもセルは独立にトグル（表示/非表示）する読み。粒度は作家が選んだ単位で宣言される。
 */
export interface VariantAxis {
  id: string;
  name: string;
  /** フォルダ式のみ: 差し替え点フォルダの id。選択式(slotless)では undefined。 */
  slotId?: string;
  cells: VariantCell[]; // 順序付きセル一覧。各セルは独立にトグル（表示/非表示）する。
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
