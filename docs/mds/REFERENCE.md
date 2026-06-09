# REFERENCE: Nonlinear Revision Control for Images — 実装リファレンス

> このファイルは原論文2本から「実装に必要な部分だけ」を抽出・整理したものです。
> SPEC.md と併せて Claude Code に渡してください。擬似コード・数式・表は原典に忠実、
> 説明文は要約です。詳細は元PDF（docs/）を参照のこと。

## 出典

- **[原論文]** H.-T. Chen, L.-Y. Wei, C.-F. Chang. "Nonlinear Revision Control for Images." ACM Transactions on Graphics 30(4), Article 105, July 2011. DOI: 10.1145/1964921.1965000
- **[再実装]** "A Revision Control System for Image Editing in Collaborative Multimedia Design"（arXiv:1806.00263v2）— 原論文を Python でゼロから再実装した事例。

本リファレンスでは前者を **[P]**、後者を **[R]** と表記する。

---

## 1. 基本概念

### DAG（Directed Acyclic Graph）— コアデータ構造 [P]

- ノード = 1つの画像編集操作（type / params / 影響領域 / layerID を持つ）。
- エッジ = 操作間の関係。**有向の直列パス** = 空間的および/または意味的依存（向き = 時間順）。**並行する複数パス** = 独立した操作列（互いに素な領域、または直交する意味）。
- DAG は編集のたびに成長する。
- **各リビジョン = ルートノードを含む DAG の部分グラフ。** リビジョンの状態は、その部分グラフを辿って操作を再適用した結果と常に等しい。
- 重要: **DAG が保存するのは操作（action）であって画像そのものではない。** Git/SVN/CVS が各リビジョンを画像ファイルとして保存するのと対照的。
- ルートノード = 初期化操作（空キャンバスを開く or 既存画像をロード）。

### RevG（Revision Graph）— 可視化レイヤ [P]

- DAG は複雑になりうるため、一般ユーザには直接見せない。代わりに状態ベースの可視化グラフ RevG を見せる。
- RevG は DAG の**多重解像度グラフ可視化**。最高解像度の RevG = DAG そのもの。
- 各 RevG ノードは1つ以上の DAG ノードの集約。RevG ノードにはサムネイル画像を埋め込む。
- ノード枠の色 = 操作クラス（後述 Table 1）。

---

## 2. 操作クラスと依存判定

### 操作クラス（Table 1）[P]

| クラス | 含まれる操作 | 意味的独立性 |
|---|---|---|
| rigid transformation（剛体変換） | translation, rotation | **独立（上位3クラス）** |
| deformation（変形） | scale, shear, perspective | **独立** |
| color and filter（色・フィルタ） | hue, saturation, color balance, brightness, contrast, gamma, color fill, blur, sharpen | **独立** |
| edit（編集） | copy, paste, anchor, add layer, layer mask | 依存扱い |
| brush（ブラシ） | brush, pencil, eraser | 依存扱い |

**上位3クラス（rigid / deformation / color&filter）は互いに意味的に独立。** 同一オブジェクト/領域に対する意味的独立な操作は並行パスに置く。

参考: [R] の実装で「新しいDAGノードを生成する操作」一覧（Table I）:

| Type | Operation |
|---|---|
| Rigid Transformation | Mirror, Flip, Transpose |
| Deformation | Scale |
| Color and Filter | Histogram, Brightness, B&W, Sepia, Invert, Solarize, Posterize |
| Edit | Crop, Text, Reset |
| Brush | Brush |
| Load image | New, Import |

### 依存の2種類 [P][R]

DAG は2種類の依存を記録する。

1. **空間的依存（spatial）**: 操作領域が重なれば依存、重ならなければ独立。
   - 例: 図形を描く操作と、その図形を塗る操作 → 空間的に依存。
   - 例: 図形を描く操作と、別の既存図形を塗る操作 → 独立。
2. **意味的依存（semantic）**: 上記クラス分類に基づく。上位3クラスのうち異なるクラスどうしは独立。

→ 挿入対象 c と既存ノード v が依存とみなされる条件:
`dependent(c, v) = spatialOverlap(c, v) OR semanticallyDependent(c, v)`

---

## 3. コアアルゴリズム

### Algorithm 1: Node Insertion（DAG構築）[P]

操作を1つずつ順に挿入してDAGを構築する。挿入時、既存DAG内の依存ノードを探索し、依存ノード群が連結（パスで繋がっている）なら**その中の最新ノード**を親に選ぶ。後順DFS（post-order DFS）で効率的に行える。

```
// c : DAGに挿入するノード
// P : c の親集合（初期は空）
// L : DAG内のノードを post-order DFS 順に並べたもの

while L ≠ ∅ do
    v = pop_front(L)
    if v and c are dependent then
        P = P ∪ {v}
        remove parents of v from L     // v の親（祖先方向）を候補から除外
    end if
end while
insert directed edges from nodes in P to c
```

ポイント: 後順DFSで子側から走査し、依存ノードを見つけたらその親方向を候補Lから除く。これにより「連結な依存ノード群のうち最新の代表だけ」が親 P に残る。

### Algorithm 2: Automatic Merge [P]

trunk と branch の2つのDAGをマージする。非衝突ノードは統合し、衝突ノードは conflict list に集める。

```
// Gi, Gj : trunk と branch のDAG
// Gm     : マージ後のDAG
// L      : Gj のノードを BFS 順に並べたもち
// CL     : conflict list

Gm ← Gi
while L ≠ ∅ do
    v = pop_front(L)
    if v conflicts with nodes in Gm then
        remove children of v from L
        push v and its children into CL
    else
        insert v into Gm with Algorithm 1
    end if
end while
```

- 衝突ノードが見つかったらその子孫もまとめて CL に送る（子をLから除去）。
- 非衝突ノードは Algorithm 1 を使って Gm に挿入。
- **任意領域のマージ**は、選択画像領域に対応するDAGノード群に Algorithm 2 を適用することで実現する。

---

## 4. Revision Diff [P][R]

- リビジョン間の差分抽出 = 下層DAGどうしのグラフ差分問題。
- グラフの1対1対応をゼロから計算するのはグラフ同型判定（NP完全）に等しい。
- **回避策: ノードの label（元のアクションログから記録）を一致させることで共通ノードを抽出する。** 残りが差分ノード。
- 注意: 異なるブランチ上では、実際は同一操作なのに label が異なるノードがありうる。本システムでは「label が違えば差分」と単純に扱い、diff 可視化としては十分実用的と判断している。

### Diff UI [P][R]

- 2ノードを選択して起動。左にプレビュー（編集過程）、中央/右に2リビジョン。
- スライダーで任意の中間状態へ、再生ボタンで自動再生。
- RevGから起動した場合、長すぎるアニメを避けるため visual importance に従って **15ステップ**（総数が15未満なら全部）を抽出。
- refresh ボタンで2リビジョンを点滅切替 → その場比較。
- 差分領域の bounding box を表示するチェックボックス。
- **グローバルな編集（例: gamma補正）を無視し、局所的な変更だけを強調できる**のが低レベルbitmap差分に対する利点。

---

## 5. Revision Branch & Merge UI [P]

### Branch
- ソフト開発と違い、お絵かき/画像編集では単一ユーザでも branch が重要（試行錯誤・複数バリエーション保持のため）。

### Merge
- マージ対象: (1) 両方チェックイン済み（trunk と branch）、または (2) trunk と未チェックインのローカルコピー。
- まず非衝突部分を自動マージ（Algorithm 2）。多くの場合これで十分。
- 衝突部分はデフォルトで **trunk only** を採用。
- 自動結果が不満な場合は merge UI で手動解決。merge UI は3画像（左右=対象リビジョン、中央=プレビュー結果）を同期表示し、ドラッグ/ズーム/領域選択可能。

### 領域選択時の4つの結合モード [P]
領域を選択すると、以下4通りの組み合わせをボタンクリックで選べる:

1. **trunk only**
2. **branch only**
3. **trunk after branch**
4. **branch after trunk**

### [R] における簡易マージ実装（参考）
- 画像をピクセル行列（各要素 = RGBA, 各値0-255）として表現。
- 2ノード間でピクセル単位 diff を取り、差分を適用した新ノードを生成。
- **同一ピクセルを両方が変更している場合、衝突を出さず「最新（latest）」の変更で上書き**（全アクションはタイムスタンプ付きで記録されている前提）。

---

## 6. 多重解像度 RevG / Visual Importance Filter [P]

RevG は DAG に「フィルタ」のリストを適用して生成する:
- **viewport filter**: 表示範囲外のRevGノード/エッジを間引く。
- **layout filter**: 古典的な階層レイアウトアルゴリズム（Gansner et al. 1993）でノードの位置・パス・形・色を決める。
- **visual importance filter**: 下記。
- フィルタは汎用インターフェースで、ユーザがカスタムフィルタを追加可能。

### Visual Importance の計算

各DAGノード n（操作 act(n) を1つ含む）の視覚的重要度 v(n):

```
v(n) = (1/w) · Σ_{m ∈ N(n)}  I(n, m) · A(n, m)
```

- `N(n)`: DAG上で距離 w 以内の n の近傍ノード。**現実装では w = 2**。
- `I(n, m)`: act(n) と act(m) を適用した画像どうしの**低レベルなピクセル単位差分**。
- `A(n, m)`: アクションのコンテキスト項。
  - act(n) と act(m) の **type または params が異なる**場合: `A(n, m) = 10^d`（d = n と m の距離）。
  - 同一の場合: `A(n, m) = 1`。
  - これにより、近傍と異なる操作には高い重要度を、似た/同一の操作（例: 連続するブラシストローク）には低い重要度を割り当てる。
  - 柔軟に調整可能。例: "add layer" 操作には高い値（実装では **100**）を与える（ユーザはレイヤ単位で履歴を見たいため）。
- I(n,m) には Itti et al. 1998 / Yee et al. 2001 のような高度な視覚的注意・知覚解析も使えるが計算コスト大。低レベル I と高レベル A の組み合わせで十分実用的。

### ノード集約（クラスタリング）
1. 全ノードに v(n) を割り当てる。
2. DAG を DFS 順に辿り、visual importance を累積。
3. 累積値が**現解像度の閾値**を超えたら、対応するノード群を1つの RevG ノードに集約。
4. 集約後にエッジを張り直す。
- 手法は古典的な multi-resolution mesh simplification（Hoppe 1996）やグラフ可視化（Fairchild 1999, Heer & Card 2004）に類似。

---

## 7. Logger & Replayer [P][R]

### Logger
- ユーザの編集操作をバックグラウンドで静かにテキストログとして記録。
- **連続する同一ログは統合（consolidate）する**（Grabler et al. 2009 と同様）。
- アクションログの構成要素: action name, action parameters, layer ID, selection mask。
- ブラシ/スケッチ操作はさらに **マウス/スタイラスの軌跡と筆圧**も記録。
- [P] ではログを ASCII 形式で保存。

### Replayer
- ログを順に再適用して画像を再構築。
- [P] では GIMP の PDB（procedure database）経由で操作を再生。

### [R] のログファイル構成（参考、標準フォーマット採用）
操作が画像を変更するたびに3つのログを生成:
- ノード情報を含む **CSV** ファイル
- DAG構造を記述する **JSON** ファイル
- リビジョン（delta）を含む **CSV** ファイル

加えてプロジェクトごとに `Project.properties`（author, revision format 等）を生成。すべてのユーザ操作をログに注記することで、異なるプラットフォーム/OS間でのポータビリティを確保。

---

## 8. システムアーキテクチャ [P]

3モジュールを直交化（疎結合）させる設計（Figure 7）。Prefuse や Kitware VTK のアーキテクチャを参考。

```
┌──────────────────────────────┐
│ Editing Software (GIMP)       │
│   - Logger  - Replayer        │
└───────────┬──────────────────┘
            │
┌───────────▼──────────────────┐
│ Revision Control Backend      │
│   Repository                  │
│   DAG Construction → DAG       │
│   Filters → RevG              │
└───────────┬──────────────────┘
            │
┌───────────▼──────────────────┐
│ UI Frontend                   │
│   Renderer (GTK)              │
└──────────────────────────────┘
```

この分離により、別の画像編集ソフトやOSへの統合が容易。

---

## 9. リビジョン・ナビゲーション（多重解像度UI）[P]

- RevG は複雑な履歴に対応するため多重解像度ビューを提供。
- 粗い resolution（リビジョン単位）から細かい action 単位まで連続的にナビゲート可能。
- サムネイル画像を各RevGノードに直接埋め込む。
- 各ノードに記述ラベルとクラス別の枠色を付与。
- **双方向選択**: RevGノードをクリック → メイン編集ウィンドウで対応する変更領域を bounding box でハイライト。逆に画像領域を選択 → 対応するRevGノードをハイライト。

---

## 10. ストレージ効率（実装の検証用ベンチマーク）[P]

各図の編集過程を4リビジョンに分けてコミットしたときのストレージサイズ比較（K-bytes）。本システムの利点を示すデータ。

| input | #op | GIMP(.xcf) | SVN | GIT | our |
|---|---|---|---|---|---|
| Figure 1 | 502 | 2.7K | 2.1K | 2.0K | **640** |
| Figure 3 | 1.6K | 672* | 267 | 224 | 180 / **73** |
| Figure 8 | 945 | 3.5K | 3.7K | 3.6K | **1.3K** |
| Figure 9 | 276 | 972 | 1.2K | 1.2K | **420** |
| Figure 10 | 377 | 2.3K | 2.4K | 2.5K | **652** |
| Figure 11 | 425 | 2.5K | 2.7K | 2.7K | **775** |

（*表内の数値はOCR由来のため概算。傾向として our が一貫して最小。本システムのストレージ overhead は主にキャッシュしたサムネイル画像由来。）
処理速度は interactive speed で動作し、ユーザは元のGIMPや他のRC systemと比べて速度低下を感じなかった。

---

## 11. 実装上の留意点まとめ（Web版への翻案）

- [P] の最大の苦労は「GIMPに操作フックを手で配線する」こと（GIMP 2.8時点でコマンドログ用APIが無かった）。**Web自作エディタなら全編集を単一関数に通すだけでこの問題が消える** → 最大の利点。
- [R] は GIMP をフォークせず軽量エディタをゼロから作り、Python + Pillow + NetworkX + matplotlib + Tkinter + JSON/CSV + Git/Git-LFS で構成。これは Web/TS 版でもほぼそのまま対応づけられる方針。
- diff のグラフ対応は同型判定を避け **label マッチ**で近似（実装が大幅に簡単になる）。
- merge の衝突は、厳密な意味解決をせず **latest 上書き** + **4モード手動選択**で実用十分。
- 操作の**決定性**（同入力→同出力）が Replayer 成立の前提。ブラシは点列+筆圧、乱数フィルタは seed を必ず記録すること。
