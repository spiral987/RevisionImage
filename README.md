# Nonlinear Revision Control for Images（Web版・追実装）

Chen, Wei, Chang. "Nonlinear Revision Control for Images." ACM TOG 30(4), 2011 の追実装。
画像そのものではなく **編集操作(action)** を記録し、DAG で依存を表現する。

仕様: [`docs/mds/SPEC.md`](docs/mds/SPEC.md) / アルゴリズム: [`docs/mds/REFERENCE.md`](docs/mds/REFERENCE.md)

## セットアップ

```bash
npm install
npm run dev      # 開発サーバ
npm test         # ユニットテスト (vitest)
npm run build    # 型チェック + 本番ビルド
```

## 実装状況

### ✅ Phase 1 — Editor + Logger

- **Engine（純TS, DOM非依存）**
  - `applyOperation(state, op)`: すべての編集が通る単一の決定的純関数（SPEC §6）。
  - 操作6種: `brush` / `eraser` / `translate`（レイヤ移動）/ `brightness` / `hue` / `addLayer`。
    各操作は同入力→ビット同一出力を保証する純関数（`src/engine/operations/`）。
  - `ImageBuffer` は DOM の `ImageData` に依存しない `{width,height,Uint8ClampedArray}`。
- **Backend（純TS, DOM非依存）**
  - `Logger`: 操作を append し、連続する同型・同レイヤ操作を consolidate（統合）。
    統合は「逐次適用＝統合1回適用がビット同一」になる操作のみ実装（brush/eraser=点列連結,
    translate=オフセット加算）。clamp により非結合となる色操作は統合しない。
- **UI（React）**: `CanvasEditor` — Canvas 2D、複数レイヤ、ツール/色調整/レイヤ/操作ログのパネル。

#### 受け入れ条件の対応

| 条件 | 対応 |
|---|---|
| キャンバスで描画・色調整ができる | `CanvasEditor`（brush/eraser/translate + brightness/hue ボタン式調整） |
| 操作のたびに `logger.getLog()` に積まれる | `EditorSession.apply` が `applyOperation` + `logger.append` を実行 |
| 連続ブラシが1操作に統合される | `brushHandler.consolidate`（点列連結 + `down` サブストローク境界）+ `Logger` |

**レイヤモデル（非破壊）**: レイヤは `buffer` ＋ `offset` で表現。`translate` はオフセットのみ変更する
非破壊操作。ブラシ描画時はオフセットがあっても全面に描けるよう、必要に応じて `growBufferToInclude`
でレイヤバッファを動的拡張する（合成はバッファサイズ・オフセットを問わずキャンバスにクリップ）。

**ブラシ統合の正しさ（`down` フラグ）**: 別々のブラシ操作を点列連結で統合する際、操作間に偽の連結線が
出ないよう各操作の先頭点を `down`（ペンダウン=サブストローク開始）でマークし、ラスタライザはそこで
連結線を引かない。これにより非連続な複数ジェスチャでも「逐次適用 == 統合1回適用」が厳密に成立する。

**色調整UI（ボタン式）**: brightness/hue はスライダーではなく `−/＋` ボタン。1クリック=固定量の相対調整を
1操作として記録する（相対調整 = 独立操作という設計、および clamp/丸めで絶対値再現が難しいことに対応）。

> **設計上の核**: `EditorSession.state === replay(getLog())` を不変条件として維持している
> （`test/session.invariant.test.ts` で検証）。これにより「画像を保存せず操作だけ保存する」
> という論文の核が成立する。

### ✅ Phase 2 — Replayer

- **`Replayer`（純TS, DOM非依存）** — `src/backend/replayer.ts`
  - `replay(log, upTo?)`: ルート（空キャンバス）から log を順に `applyOperation` で再適用。
    `upTo` で先頭 k 操作後の中間状態を取得（サムネイル用、範囲外はクランプ、0=ルート）。
  - `replayAll(log)`: `[root, after#1, …, after#N]` を1パスで返す（構造共有でメモリ効率良）。
  - `replayToImage(log, upTo?)`: 合成済み `ImageBuffer` を返す。
  - 戻り値は純TS型（SPEC の `ImageData` ではなく `EditorState`/`ImageBuffer`）。SPEC §3/§10.2
    「Backend は DOM 非依存」を優先し、Node でのピクセル一致検証を可能にした。UI 側で `ImageData` に変換。
- **`flattenState`（純TS合成）** — `src/engine/composite.ts`。レイヤを白背景上に source-over 合成。
  UI 表示(`render.ts`)・replay・サムネイルがすべてこの1経路を通り、表示と検証のピクセルが一致する。
- **UI**: 履歴スクラブスライダー（`replay(log, upTo)` で過去状態を読み取り専用プレビュー）と
  「Verify replay」ボタン（ログだけから再構築しライブ状態とビット一致するか検証）。

#### 受け入れ条件の対応

| 条件 | 対応 |
|---|---|
| 編集→ログ取得→全消去→replay で元画像とピクセル一致 | `test/replayer.test.ts`（state/画像両レベルで検証）+ UI の Verify replay |
| `upTo` で途中状態のサムネイル生成 | `Replayer.replay(log, k)` / `replayAll` + UI 履歴スクラブ |

### 構成

```
src/
  engine/        # 純TS。operation(applyOperation/registry), operations/*, imageBuffer, layer,
                 #        geom, composite(flatten), compare(statesEqual)
  backend/       # 純TS。logger, replayer（以降 dag/diff/merge/repository を追加）
  ui/            # React。CanvasEditor / render（合成）
  session.ts     # engine + backend を束ねる編集セッション（単一の編集チョークポイント）
  types.ts
test/            # 決定性 / consolidate / 往復不変条件 / replayer / composite
```

### ✅ Phase 3 — DAG構築（Algorithm 1）

- **依存判定** — `src/backend/dependency.ts`
  - `dependent(a, b) = spatialOverlap(a,b) AND semanticallyDependent(a,b)`。
  - `semanticallyIndependent`: 上位3クラス(rigid/deform/color)同士の異クラスのみ true。
  - `spatialOverlap`: **画像領域(bbox)の交差のみ**で判定（原論文どおり。レイヤ所属では判定しない）。
  - **⚠ SPEC/REFERENCE の擬似コード `dependent = spatial OR semantic` は誤り**。原論文 §5 本文
    「independent ⇔ 空間的に独立 OR 意味的に独立」より、`dependent = spatial AND semantic` が正しい。
    `docs/pdfs` の原論文で確認済み（OR だと論文の例・受け入れ条件すべてに矛盾）。
  - **領域(region)の精度**: color/translate の影響範囲は全面ではなく**レイヤ内容の bbox**
    （`layerContentBBox`）を用いる＝原論文の selection mask 相当。これにより領域ベース判定でも
    過剰な直列化を避け、離れた領域の操作は並行になる。`addLayer` は edit クラス・全面領域の
    構造的チェックポイントとして先行操作に連結する（root に孤立しない）。
- **DAG データ構造** — `src/backend/dag.ts`（ルートノード=初期化操作, `postOrderDFS`, `ancestors`,
  `isAcyclic`）。
- **Algorithm 1（ノード挿入）** — `src/backend/dagBuilder.ts`。後順DFSで走査し、依存ノードを
  見つけたらその祖先を候補から除外して「連結な依存群の最新代表だけ」を親に選ぶ。並行ブランチ
  双方に依存する操作は複数親（マージ点）になる。孤立操作はルートに接続。`buildDag(log,w,h)` /
  `session.getDag()`。
- **UI**: 操作ログの各行に依存親（`← root` / `← #n`）を表示し、DAGの並行/直列を可視化。

#### 受け入れ条件の対応

| 条件 | 対応 |
|---|---|
| 独立操作（別レイヤ色調整 と 重ならない領域ブラシ等）が並行パスに分かれる | `test/dag.test.ts`（並行: 空間/レイヤ/意味の3種） |
| 依存操作が直列パスになる | `test/dag.test.ts`（重なるブラシ→直列、連結群は最新のみ親） |
| 生成グラフが必ず非巡回(DAG) | `isAcyclic` を `test/dag.test.ts` で検証 |

### ✅ Phase 4 — RevG 可視化

- **layout filter（dagre）** — `src/backend/filters/layout.ts`。DAG を階層レイアウト（Gansner 相当）で
  配置し、各ノード座標・エッジ経路を返す純TS。`layoutDag(dag, opts)`。
- **`RevGView`（SVG）** — `src/ui/RevGView.tsx`。各ノードに `Replayer.replayAll` のフラット画像を
  縮小したサムネイル（`<image>`）を埋め込み、枠色を操作クラス別に色分け（Table 1）。依存エッジを
  polyline で描画。ノードクリックで選択。
- **双方向選択** — RevG ノードクリック → キャンバスに該当 `region` を黄色ハイライト。`select` ツールで
  キャンバス領域を矩形選択 → 重なる最新操作ノードを強調。`App` が session・選択状態・DAG を保持し、
  `CanvasEditor` と `RevGView` を連携。

#### 受け入れ条件の対応

| 条件 | 対応 |
|---|---|
| DAG がサムネイル付きグラフとして描画される | `RevGView`（dagre 配置 + replay サムネイル + klass 枠色） |
| ノードクリックで対応領域がキャンバスにハイライトされる | `App` の `selectedNodeId`→`region`→`CanvasEditor` の黄色矩形描画 |

`layoutDag` は `test/layout.test.ts` で検証（全ノードに有限座標 / 直列は子が下 / 並行は同 rank）。

### ✅ Phase 5 — Revision Diff

- **リビジョン（最小機構）** — `src/backend/revision.ts` / `EditorSession.commitRevision()`。
  commit 時の操作列スナップショット（凍結）を `CommittedRevision` として保持。`headIds` は DAG の末端ノード。
- **Diff** — `src/backend/diff.ts`。2リビジョン（操作集合）を受け取り、**ノードの id（=アクションログ由来の
  ラベル）一致**で共通/差分を分類（同型判定は回避＝原論文準拠）。`{ common, onlyA, onlyB, commonPrefix }`。
- **`DiffView`（SVG/Canvas）** — `src/ui/DiffView.tsx`。A/B の最終画像を並べ、中央で**スライダーにより
  差分適用過程をステップ再生**（共通プレフィックス状態を基点に対象リビジョンの差分opを順次適用）。
  差分領域の bounding box トグル（A=赤 / B=緑）、共通/Aのみ/Bのみの操作リスト。
- **UI**: `App` に Revisions パネル（Commit、2リビジョン選択 → Compare）を追加。

#### 受け入れ条件の対応

| 条件 | 対応 |
|---|---|
| 共通操作と差分操作が正しく分類される | `diffOps`（id一致）+ DiffView の 共通/Aのみ/Bのみリスト・`test/diff.test.ts` |
| スライダーで差分の適用過程をステップ再生できる | DiffView 中央プレビュー（`replay(targetRev.ops, commonPrefix + step)`） |

> 注: checkout/branch は未実装のため、現状のリビジョンは主に**チェックポイント間の差分**（一方が他方の
> プレフィックス）になります。diff アルゴリズム自体は分岐リビジョンにも対応（`test/diff.test.ts` で検証）。

### ✅ Phase 6 — Branch & Merge（Algorithm 2）

- **checkout（最小分岐機構）** — `EditorSession.checkout(ops)` / `Logger.setLog`。過去リビジョンを作業状態に
  読み込み、そこから分岐編集できる（Merge を試すために必須なので Phase 6 で導入）。
- **Merge（Algorithm 2）** — `src/backend/merge.ts`。原論文擬似コードに忠実: branch を BFS 走査し、
  非衝突ノードは Algorithm 1 で Gm に統合、衝突ノードは子孫ごと conflict list へ集約。
  衝突判定 = 同一レイヤ かつ 領域(bbox)重なり。
- **4結合モード** — `trunk only / branch only / trunk after branch / branch after trunk`。
  `buildMergedOps` が解決に従い replay 可能な操作列を生成（after は後勝ち＝上書き、[R] の latest 上書きを一般化）。
- **`MergeView`** — trunk / merged プレビュー / branch の3画像、conflict list、衝突ごとの4モード切替、
  「この結果を commit」（merged を checkout して新リビジョン化）。

#### 受け入れ条件の対応

| 条件 | 対応 |
|---|---|
| 衝突しない分岐操作が自動統合される | `mergeDags`（非衝突は Algorithm 1 で統合）・`test/merge.test.ts` |
| 衝突ノードが conflict list に集約され、UI で解決できる | `MergeResult.conflicts` + `MergeView` の4モード選択 |
| 4つの結合モードが切り替えられる | `buildMergedOps`（4モードで結果が変わることを `test/merge.test.ts` で検証） |

> Merge には分岐リビジョンが必要なため、Phase 5 で見送った checkout を最小実装で導入した。
> 使い方: あるリビジョンを Checkout → 別の編集 → Commit、で分岐リビジョンを作り、2つ選んで Merge。

### ✅ Phase 7 — 永続化 + 多重解像度（visual importance filter）

- **永続化** — `src/backend/repository.ts`。`serializeProject`（操作ログ + リビジョンを JSON 化、DAG は
  log から再構築可能なので保存しない）+ IndexedDB 保存/読込。`session.loadProject`。`App` が編集の
  たびにデバウンス自動保存し、起動時に IndexedDB から復元。**JSON エクスポート/インポート**ボタンも提供。
- **visual importance filter** — `src/backend/filters/importance.ts`。
  `v(n) = (1/w) Σ_{m∈N(n)} I(n,m)·A(n,m)`（w=2、I=低レベルピクセル差分、A=type/params 差で 10^d・
  同一で 1・addLayer で 100）。`buildRevG(dag, flats, resolution)` が重要度の高いノードをアンカーに残し、
  他を祖先方向のアンカーへ吸収して RevG クラスタに集約、エッジを張り直す。
- **解像度スライダー** — `RevGView` に追加。`resolution=1` で DAG そのまま、下げると連続的にノード数が減少
  （集約ノードは重ねノードとサムネイル＋`(+n)` で表示）。`layoutNodes` でクラスタを dagre 配置。

#### 受け入れ条件の対応

| 条件 | 対応 |
|---|---|
| リロード後もプロジェクトが復元される | IndexedDB 自動保存 + 起動時復元、`serialize/loadProject` 往復を `test/repository.test.ts` で検証 |
| 解像度スライダーで RevG のノード数が連続的に増減する | `buildRevG`（単調減少・全ノード内包を `test/importance.test.ts` で検証）+ `RevGView` スライダー |

---

## 完成

Phase 1〜7 すべて実装完了。`npm test` で全テスト green、`npm run build` 成功。

### 主要な設計判断（原典との差分は意図的）
- 依存判定は `spatial AND semantic`（SPEC擬似コードの OR は誤り、原論文で確認）／領域ベース。
- consolidate は「逐次適用＝統合1回適用がビット同一」になる操作のみ（brush/eraser/translate）。
- レイヤは非破壊（buffer+offset、ブラシ描画時にバッファ動的拡張）。
- `Replayer`/各フィルタは `ImageData` ではなく純TSの `ImageBuffer`/`EditorState` を返す（DOM非依存・テスト容易）。

---

## 実用化（ペイントUI改善 / 機能追加）

研究実装(Phase 1〜7)の上に、実際に絵を描いて検証できるよう実用機能を追加。**いずれも
`state === replay(log)` の不変条件を壊さない**設計（新機能は純粋な操作として log に記録し、
リロード復元・DAG・Undo/Redo すべてと自動的に整合する）。

- **編集の使い勝手**: Undo/Redo（`EditorSession` がログのスナップショット列で管理。consolidate に
  関わらず 1 ジェスチャ＝1 Undo）、キーボードショートカット（B/E/G/I/L/R/V/S、`[ ]`=サイズ、
  Ctrl+Z / Ctrl+Shift+Z）、ブラシサイズを示すリングカーソル。
- **画像の入出力**: 画像を新規レイヤとして読み込み（`addImageLayer` 操作 — 画素を base64 で op に
  保持し replay で決定的に再構築）／現在の合成を **PNG 書き出し**。
- **レイヤー操作**: 表示切替・不透明度・リネーム・削除・並べ替え。すべて操作化
  （`setLayerVisibility` / `setLayerOpacity` / `renameLayer` / `removeLayer` / `reorderLayer`、
  絶対値セット系は last-wins で consolidate）。不透明度はドラッグ中プレビュー＋離した時に1操作。
- **描画ツール**: 塗りつぶし（`fill` = flood fill, klass=color, tolerance 可変）、スポイト（合成から
  採色、操作ログには残さない）、直線・矩形（点列を組んで**ブラシ操作として再現** — 新規 op 不要）。

追加テスト: `session.undo` / `addImageLayer` / `layerOps` / `fill`（往復不変条件・consolidate・
境界挙動を検証）。全テスト green、`npm run build` 成功。
