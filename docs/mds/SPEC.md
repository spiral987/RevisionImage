# 仕様書: Web版 Nonlinear Revision Control for Images（追実装）

## 0. このドキュメントの使い方

本仕様は Claude Code に与える実装指示書です。**フェーズ単位で実装すること。** 各フェーズには「受け入れ条件(Acceptance Criteria)」があり、それを満たすまで次フェーズに進まない。フェーズ1〜3が完成した時点でシステムの中核（ノンリニア版管理）が動作する。

参照論文:
- Chen, Wei, Chang. "Nonlinear Revision Control for Images." ACM TOG 30(4), 2011.（原論文）
- arXiv:1806.00263v2 — 上記を Python で再実装した事例（実装方針の参考）

---

## 1. 目的とスコープ

画像編集の履歴を「画像そのもの」ではなく「編集操作（action）」として記録し、操作間の空間的・時間的・意味的依存を DAG で表現する。DAG を多重解像度グラフ(RevG)として可視化し、review / diff / branch / merge / replay を提供する。

**核心となる発明:** 各リビジョンは画像ファイルではなく DAG の部分グラフであり、状態は「ルートからその部分グラフを辿って操作を再適用した結果」として再構築される。

Web を選ぶ最大の理由: 既存エディタへの操作フック注入が不要。**エディタを自作し、全編集を単一関数に通すことでロギングが自動的に成立する。**

---

## 2. 技術スタック

| 領域 | 採用 | 理由 |
|---|---|---|
| 言語 | TypeScript | 操作・DAG の型安全 |
| ビルド | Vite | 軽量・高速 |
| 描画 | Canvas 2D（生API） | レイヤとピクセル差分を完全制御。Fabric.js 等は使わない |
| グラフレイアウト | dagre | 階層レイアウト（原論文の Gansner レイアウト相当） |
| UI | React | RevG/各UIの描画 |
| RevG描画 | SVG | ノード（サムネイル付き）+ エッジ |
| 永続化 | IndexedDB | プロジェクト保存 |
| エクスポート | JSON | 1806論文と同方針（操作ログ + DAG構造） |

外部の画像処理ライブラリには依存しない。フィルタは Canvas の `ImageData` を直接操作する純関数として実装する。

---

## 3. アーキテクチャ

原論文 Figure 7 のモジュール分離を踏襲する。3層を疎結合に保つこと。

```
┌─────────────────────────────────────────────┐
│  UI Frontend (React)                         │
│   - CanvasEditor : 編集キャンバス             │
│   - RevGView     : リビジョングラフ (SVG)     │
│   - DiffView     : 2リビジョン比較            │
│   - MergeView    : マージUI                  │
└───────────────┬─────────────────────────────┘
                │
┌───────────────▼─────────────────────────────┐
│  Revision Control Backend (純TS, UI非依存)    │
│   - Logger       : 操作記録                  │
│   - Replayer     : 操作再生                  │
│   - DagBuilder   : DAG構築 (Algorithm 1)     │
│   - Filters      : viewport/layout/importance │
│   - Diff / Merge : Algorithm 2 等             │
│   - Repository   : 永続化                    │
└───────────────┬─────────────────────────────┘
                │
┌───────────────▼─────────────────────────────┐
│  Engine (純TS)                               │
│   - Operation 定義群（決定的な純関数）         │
│   - LayerStack / ImageBuffer                 │
└─────────────────────────────────────────────┘
```

**重要な制約:** Backend と Engine は React/DOM に一切依存しない純TSにする。テストしやすく、将来 Node/サーバへ移植可能にするため。

---

## 4. ディレクトリ構成

```
src/
  engine/
    operations/        # 各操作（brush, translate, hue, ...）
    operation.ts       # Operation 型と registry
    layer.ts
    imageBuffer.ts
  backend/
    logger.ts
    replayer.ts
    dag.ts             # DAG データ構造
    dagBuilder.ts      # Algorithm 1
    dependency.ts      # 空間的/意味的依存判定
    filters/
      viewport.ts
      layout.ts        # dagre ラッパ
      importance.ts    # visual importance filter
    diff.ts
    merge.ts           # Algorithm 2
    repository.ts      # IndexedDB / JSON
  ui/
    CanvasEditor.tsx
    RevGView.tsx
    DiffView.tsx
    MergeView.tsx
    App.tsx
  types.ts
test/
  ...
```

---

## 5. データモデル（types.ts）

```ts
export type OpClass = 'rigid' | 'deform' | 'color' | 'edit' | 'brush';
// rigid: translation, rotation
// deform: scale, shear, perspective
// color: hue, saturation, brightness, contrast, gamma, fill, blur, sharpen
// edit:  copy, paste, anchor, addLayer, layerMask, crop
// brush: brush, pencil, eraser
// 注: 最初の3クラス(rigid/deform/color)は互いに意味的独立

export interface BBox { x: number; y: number; w: number; h: number; }

export interface Operation {
  id: string;
  type: string;          // "brush" | "translate" | "hue" など具体名
  klass: OpClass;
  params: Record<string, unknown>;
  region: BBox;          // 影響範囲。MVPでは bbox で近似
  layerId: string;
  // ブラシ系のみ: 点列と筆圧
  strokes?: { x: number; y: number; pressure: number }[];
  seed?: number;         // 乱数を使う操作は必須（決定性確保）
  timestamp: number;
}

export interface DagNode {
  id: string;            // = Operation.id
  op: Operation;
  parents: string[];
  children: string[];
}

export interface Dag {
  rootId: string;        // 初期化操作（空キャンバス or 画像ロード）
  nodes: Map<string, DagNode>;
}

export interface Revision {
  id: string;
  label: string;
  headIds: string[];     // このリビジョンの末端ノード群
  timestamp: number;
}
```

---

## 6. 設計の最重要原則: 操作の決定性

すべての操作は **決定的な純関数** とする。

> 同じ入力画像 + 同じ params(+ seed) → 必ずビット同一の出力

これが保証されれば Replayer は `operations.reduce(apply, initialImage)` で書ける。違反すると履歴再構築が破綻する。具体策:

- ブラシ: マウス/スタイラスの点列と筆圧を `strokes` に記録（補間も決定的に）。
- 乱数を使うフィルタ（ノイズ等）: `seed` を必ず記録し、シード付き PRNG を使う。
- 浮動小数の順序依存に注意（同じ順で適用する）。

すべての編集は必ずこの単一関数を通す:

```ts
function applyOperation(state: EditorState, op: Operation): EditorState
```

UI のボタン/ブラシ操作は直接 canvas を触らず、必ず `Operation` を生成して `applyOperation` に渡す。これにより Logger は `applyOperation` の中で1回 emit するだけでよい。

---

## 7. 実装フェーズ

### Phase 1 — エディタ + Logger

**実装:**
- `CanvasEditor`: Canvas 2D。複数レイヤ（`LayerStack`）。
- 操作を最低6種実装: `brush`, `eraser`, `translate`(レイヤ移動), `brightness`, `hue`, `addLayer`。すべて `applyOperation` 経由。
- `Logger`: `applyOperation` 内で `Operation` を配列に append。連続する同一タイプ・同一レイヤの操作は consolidate（統合）する（原論文 5.1）。

**受け入れ条件:**
- キャンバスで描画・色調整ができる。
- 操作するたびに `logger.getLog()` に `Operation` が正しく積まれる。
- 連続ブラシが適切に1操作に統合される。

---

### Phase 2 — Replayer

**実装:**
- `Replayer.replay(log: Operation[], upTo?: number): ImageData`
  ルート（空 or ロード画像）から log を順に `applyOperation` で再適用。
- 任意の i 番目までの中間状態を返せること（サムネイル生成に使う）。

**受け入れ条件:**
- 「編集 → ログ取得 → キャンバス全消去 → replay」で**元の画像とピクセル一致**する（決定性の検証）。
- `upTo` 指定で途中状態のサムネイルが生成できる。

> このフェーズが通れば「画像を保存せず操作だけ保存する」という論文の核が成立する。

---

### Phase 3 — DAG構築（Algorithm 1）

**依存判定（dependency.ts）:**
```
dependent(a, b):  # b は既存ノード、a は挿入対象
  spatial  = regionsOverlap(a.region, b.region)   # MVPは bbox 交差
  semantic = not semanticallyIndependent(a.klass, b.klass)
  return spatial OR semantic
```
- `semanticallyIndependent`: 双方が rigid/deform/color のいずれかで、かつ klass が異なる場合に true。同一クラスや edit/brush が絡む場合は依存とみなす（原論文 Table 1 準拠）。

**ノード挿入（Algorithm 1, dagBuilder.ts）:**
原論文擬似コードに忠実に実装する。
```
insert(c):                       # c: 挿入ノード
  P = {}                         # 親候補
  L = nodes in DAG in POST-ORDER DFS order
  while L not empty:
    v = pop_front(L)
    if dependent(c, v):
      P = P ∪ {v}
      remove ancestors(v) from L    # v の親方向を候補から除外
  add directed edges from each node in P to c
```
ポイント: 後順DFSで走査し、依存ノードが見つかったらその祖先を候補から外すことで「連結な依存ノード群のうち最新のものだけ」を親に選ぶ。

**受け入れ条件:**
- 独立操作（例: 別レイヤへの色調整 と 重ならない領域へのブラシ）が**並行パス**に分かれる。
- 依存操作が直列パスになる。
- 生成グラフが必ず非巡回（DAG）であることをテストで保証。

---

### Phase 4 — RevG 可視化

**実装:**
- `filters/layout.ts`: dagre で各ノード座標を計算。
- `RevGView.tsx`: SVG でノード（`Replayer.replay(0..i)` のサムネイルを `<image>` で埋め込む）+ 依存エッジを描画。ノード枠色は klass ごとに色分け（原論文 Table 1）。
- 双方向選択: RevGノードクリック → CanvasEditor 側に該当 `region` の bounding box をハイライト。逆にキャンバス領域選択 → 該当ノード強調。

**受け入れ条件:**
- DAG がサムネイル付きグラフとして描画される。
- ノードクリックで対応領域がキャンバスにハイライトされる。

---

### Phase 5 — Diff

**実装（diff.ts）:**
- 2リビジョン（2つの DAG 部分グラフ）を受け取り、**ノードのラベル一致**で共通ノードを抽出（完全な同型判定はNP完全なので行わない／原論文準拠）。残りを差分ノードとする。
- `DiffView.tsx`: side-by-side 比較 + スライダーで順次 replay（1806論文 Diff UI 相当）。

**受け入れ条件:**
- 共通操作と差分操作が正しく分類される。
- スライダーで差分の適用過程をステップ再生できる。

---

### Phase 6 — Merge（Algorithm 2）

**実装（merge.ts）:** 原論文擬似コードに忠実に。
```
merge(Gi, Gj):                   # Gi=trunk, Gj=branch
  Gm = copy(Gi)
  L  = nodes in Gj in BFS order
  CL = []                        # conflict list
  while L not empty:
    v = pop_front(L)
    if conflicts(v, Gm):
      remove children(v) from L
      push v and its children into CL
    else:
      insert v into Gm using Algorithm 1
  return { merged: Gm, conflicts: CL }
```
- `conflicts`: 同一領域・同一対象に対する両立しない操作。MVP では「同一レイヤの同一ピクセル領域を変更する操作」を衝突とし、デフォルトは **trunk only / branch only / trunk-after-branch / branch-after-trunk** の4モード（原論文 Figure 6）から選択。既定は latest 上書き。
- `MergeView.tsx`: conflict list をユーザに提示し手動解決。任意領域の選択マージにも対応（選択領域に対応するノードへ Algorithm 2 を適用）。

**受け入れ条件:**
- 衝突しない分岐操作が自動統合される。
- 衝突ノードが conflict list に集約され、UI で解決できる。
- 4つの結合モードが切り替えられる。

---

### Phase 7 — 永続化 + 多重解像度（visual importance filter）

**永続化（repository.ts）:**
- IndexedDB にプロジェクト（操作ログ + DAG構造 + リビジョン）を保存。
- JSON エクスポート/インポート。

**多重解像度（filters/importance.ts）:**
各ノード n の視覚的重要度を計算し、閾値以下のノード群を1つの RevG ノードに集約する（原論文 5.3）。
```
v(n) = (1/w) * Σ_{m ∈ N(n)}  I(n,m) * A(n,m)
```
- `I(n,m)`: 操作適用後画像どうしの低レベルなピクセル差分。
- `A(n,m)`: n と m の操作タイプ/パラメータが異なれば `10^d`（d = n,m 間距離）、同一なら 1。"addLayer" には高い値（例 100）を与える。
- N(n): DAG上で距離 w 以内の近傍。w = 2。
- DAGを DFS で辿り累積重要度が閾値を超えたら、その範囲のノードをクラスタとして1ノードに集約。集約後にエッジを再接続。multi-resolution mesh simplification / graph visualization の手法に準拠。

**受け入れ条件:**
- リロード後もプロジェクトが復元される。
- 解像度スライダーで RevG のノード数が連続的に増減する（粗い俯瞰 ⇄ 細かい全操作）。

---

## 8. テスト方針

- `engine/`: 各操作の決定性ユニットテスト（同入力→ビット一致）。
- `backend/dagBuilder`: 既知の操作列に対し期待されるDAG構造（並行/直列）をアサート。非巡回性チェック。
- `backend/replayer`: 編集→replay の往復一致テスト（Phase 2 の受け入れ条件を自動化）。
- `backend/merge`: 衝突あり/なしの両ケース。

---

## 9. スコープ外（将来拡張）

- マルチユーザ / クライアントサーバ（原論文 8章。backend をサーバ側に置けば対応可能な設計にしておく）。
- Git / GitHub / Git-LFS 連携（1806論文の方向。JSONエクスポートを土台に後付け可能）。
- 動画・メッシュ等への一般化。

---

## 10. 実装順序の要点（Claude Code向け）

1. **まず Phase 1〜3 を確実に通すこと。** ここまでで中核が動く。
2. Engine と Backend を React 非依存の純TSに保つこと（テスト容易性・移植性のため）。
3. すべての編集を `applyOperation` に一本化すること（自動ロギングの前提）。
4. 操作の決定性を最優先で守ること（Phase 2 の往復テストを常にグリーンに保つ）。
5. アルゴリズム（Algorithm 1 / Algorithm 2 / visual importance 式）は本書の擬似コード・数式に忠実に実装すること。
