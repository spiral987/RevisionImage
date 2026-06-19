import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type {
  MutableRefObject,
  PointerEvent as ReactPointerEvent,
  MouseEvent as ReactMouseEvent,
} from 'react';
import type {
  BBox,
  Dag,
  EditorState,
  ImageBuffer,
  Layer,
  LayerGroup,
  LayerNode,
  Operation,
  StrokePoint,
} from '../types';
import type { EditorSession } from '../session';
import { statesEqual } from '../engine/compare';
import { applyOperation } from '../engine/operation';
import { Replayer } from '../backend/replayer';
import { ROOT_ID } from '../backend/dag';
import {
  createAddImageLayerOp,
  createAddLayerOp,
  createBrightnessOp,
  createBrushOp,
  createEraserOp,
  createHueOp,
  createTranslateOp,
  createSetLayerVisibilityOp,
  createSetLayerOpacityOp,
  createRenameLayerOp,
  createRemoveLayerOp,
  createReorderLayerOp,
  createClearLayerOp,
  createMergeDownLayerOp,
  createMoveNodeOp,
  createAddGroupOp,
  createSetGroupCollapsedOp,
  createFillOp,
  fillRegion,
  createTransformOp,
  type TransformParams,
} from '../engine/operations';
import { genId } from '../util/id';
import { layerContentBBox, isGroup, collectLeafIds, collectNodeIds } from '../engine/layer';
import { getLayer, getNode, updateNode, getParentInfo } from '../engine/editorState';
import { flattenState, compositeLayer } from '../engine/composite';
import { rasterizeSegment, stampDab, type StampFn } from '../engine/strokeRaster';
import { blendPixel, erasePixel } from '../engine/imageBuffer';
import { clampBBox, padBBox, strokesBBox, unionBBox } from '../engine/geom';
import { compositeToCanvas } from './render';
import { reorderIndex } from './layerDnd';
import { describeOp } from './opLabel';
import { ColorPicker } from './ColorPicker';
import { FloatWindow, Section } from './Float';

type Tool =
  | 'brush'
  | 'eraser'
  | 'bucket'
  | 'eyedropper'
  | 'line'
  | 'rect'
  | 'transform'
  | 'inspect';

const TOOLS: { id: Tool; label: string; key: string }[] = [
  { id: 'brush', label: 'Brush', key: 'B' },
  { id: 'eraser', label: 'Eraser', key: 'E' },
  { id: 'bucket', label: 'Fill', key: 'G' },
  { id: 'eyedropper', label: 'Pick', key: 'I' },
  { id: 'line', label: 'Line', key: 'L' },
  { id: 'rect', label: 'Rect', key: 'R' },
  { id: 'transform', label: 'Transform', key: 'V' },
  // 旧「Select」。矩形で領域を指定して履歴（操作）を特定・ハイライトする = マスクではない。
  { id: 'inspect', label: 'Inspect', key: 'Q' },
];

// S 押下中にキャンバスを上下ドラッグして太さ調整するときの感度（ドラッグpx → 太さ変化量）。
// MergeView と同じ操作感に揃える。
const SIZE_DRAG_FACTOR = 0.5;

// ---- Transform ツール（移動・拡大縮小・回転を1ツールに統合） ----
// 1ドラッグ = 1操作。move は非破壊の translate、scale/rotate は transform（resample）として確定する。
type XformGesture =
  | { mode: 'move'; startX: number; startY: number; bbox: BBox; dx: number; dy: number }
  | {
      mode: 'scale';
      corner: { x: number; y: number }; // 掴んだ頂点（ジェスチャ開始時）
      fixed: { x: number; y: number }; // 固定点 = 対角の頂点
      bbox: BBox;
      matrix: TransformParams | null;
    }
  | {
      mode: 'rotate';
      pivot: { x: number; y: number }; // 回転中心 = bbox 中心
      startAngle: number;
      bbox: BBox;
      matrix: TransformParams | null;
    };

type XformHit = { mode: 'scale'; corner: number } | { mode: 'rotate' } | { mode: 'move' };

// ハンドルの当たり判定・描画サイズ（スクリーンpx。使用時に zoom で割って canvas 座標へ換算する）。
const XF_CORNER_PX = 10;
const XF_EDGE_PX = 6;
const XF_HANDLE_PX = 7;

/** bbox の4頂点（TL, TR, BR, BL の順）。 */
function bboxCorners(b: BBox): [number, number][] {
  return [
    [b.x, b.y],
    [b.x + b.w, b.y],
    [b.x + b.w, b.y + b.h],
    [b.x, b.y + b.h],
  ];
}

/** 点 (px,py) と線分 (ax,ay)-(bx,by) の距離。 */
function segDist(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const vx = bx - ax;
  const vy = by - ay;
  const l2 = vx * vx + vy * vy;
  const t = l2 > 0 ? Math.max(0, Math.min(1, ((px - ax) * vx + (py - ay) * vy) / l2)) : 0;
  return Math.hypot(px - (ax + vx * t), py - (ay + vy * t));
}

/** スケール係数のクランプ（符号維持。0 への退化と極端な拡大を防ぐ）。 */
function clampScale(s: number): number {
  const sign = s < 0 ? -1 : 1;
  return sign * Math.min(32, Math.max(0.01, Math.abs(s)));
}

/** 行列合成 m2 ∘ m1（m1 を適用してから m2）。x'=a*x+c*y+e 表現。 */
function composeMatrix(m2: TransformParams, m1: TransformParams): TransformParams {
  return {
    a: m2.a * m1.a + m2.c * m1.b,
    b: m2.b * m1.a + m2.d * m1.b,
    c: m2.a * m1.c + m2.c * m1.d,
    d: m2.b * m1.c + m2.d * m1.d,
    e: m2.a * m1.e + m2.c * m1.f + m2.e,
    f: m2.b * m1.e + m2.d * m1.f + m2.f,
  };
}

/** ほぼ恒等変換か（確定をスキップして空opを残さない）。 */
function nearIdentity(m: TransformParams): boolean {
  return (
    Math.abs(m.a - 1) < 1e-4 &&
    Math.abs(m.b) < 1e-4 &&
    Math.abs(m.c) < 1e-4 &&
    Math.abs(m.d - 1) < 1e-4
  );
}

function hexToRgb(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return [0, 0, 0];
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function CanvasEditor({
  session,
  width,
  height,
  version,
  dag,
  onEdit,
  highlightRegion,
  onRegionSelect,
  activeLayerRequest,
}: {
  session: EditorSession;
  width: number;
  height: number;
  version: number;
  dag: Dag;
  onEdit: () => void;
  highlightRegion: BBox | null;
  onRegionSelect: (bbox: BBox) => void;
  /** 外部（Variants の pull 等）からアクティブレイヤーを指定する信号。n で再発火を保証。 */
  activeLayerRequest?: { id: string; n: number } | null;
}) {
  const replayerRef = useRef<Replayer | null>(null);
  if (!replayerRef.current) replayerRef.current = new Replayer(width, height);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const paneRef = useRef<HTMLDivElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const cursorRef = useRef<HTMLDivElement>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);
  // 中ボタン/Space ドラッグによるパン中の状態。
  const panningRef = useRef<{ x: number; y: number; left: number; top: number } | null>(null);
  const snapshotRef = useRef<HTMLCanvasElement | null>(null);
  const strokeLayerRef = useRef<HTMLCanvasElement | null>(null);
  const drawingRef = useRef<{ strokes: StrokePoint[] } | null>(null);
  // Transform ツールのドラッグ中ジェスチャ（面=移動 / 頂点=拡大縮小 / 辺=回転）。
  const xformRef = useRef<XformGesture | null>(null);
  const xformRafRef = useRef<number | null>(null);
  // 連続する変形ジェスチャの統合用。直前に確定した変形 op の id と、元バッファからの累積行列。
  // 同一ストリークが続く限り元バッファから1回だけ再サンプルし直すことで、回転の反復による
  // バッファ肥大・再サンプル累積（解像度低下）を防ぐ。
  const xformStreakRef = useRef<{ opId: string; cumulative: TransformParams } | null>(null);
  // ストリーク開始時（最初の変形 op を適用する直前）の状態。継続ジェスチャは全ログ replay せず
  // applyOperation(baseState, op) で元バッファから1回だけ再サンプルし直す（確定の重さ対策）。
  const xformBaseStateRef = useRef<EditorState | null>(null);
  const selectRef = useRef<{ startX: number; startY: number } | null>(null);
  const shapeRef = useRef<{ startX: number; startY: number } | null>(null);
  // S キー押下中の「太さ調整モード」での上下ドラッグ（押下時の clientY と太さを控える）。
  const sizeDragRef = useRef<{ startY: number; startSize: number } | null>(null);
  // Z キー押下中の「ズームモード」での上下ドラッグ（押下時の clientY・倍率・カーソル位置を控える）。
  const zoomDragRef = useRef<{ startY: number; startZoom: number; anchorX: number; anchorY: number } | null>(
    null,
  );
  // レイヤーパネルの D&D 並べ替えでドラッグ中のノード id。
  const dragIdRef = useRef<string | null>(null);
  // ドラッグ中に pointer へ追従する半透明ゴースト要素。
  const ghostRef = useRef<HTMLDivElement>(null);

  const [tool, setTool] = useState<Tool>('brush');
  const [sizeAdjust, setSizeAdjust] = useState(false); // S キー押下中 = 太さ調整モード
  const [zoomKey, setZoomKey] = useState(false); // Z キー押下中 = ズームモード
  const [color, setColor] = useState('#e23b3b');
  // size はツールごとに保持する（Brush と Eraser で別々の太さを記憶）。
  const [sizes, setSizes] = useState<Record<string, number>>({ brush: 6, eraser: 16, line: 4, rect: 4 });
  const [opacity, setOpacity] = useState(1);
  const [tolerance, setTolerance] = useState(24);
  const [activeLayerId, setActiveLayerId] = useState(session.state.activeLayerId);
  // 複数選択（Ctrl/⌘+クリックで追加）。選択レイヤー群を一発で Variants 軸にするのに使う。
  const [selectedLayerIds, setSelectedLayerIds] = useState<Set<string>>(new Set());
  const [histIndex, setHistIndex] = useState<number | null>(null);
  const [verify, setVerify] = useState<{ ok: boolean; msg: string } | null>(null);
  const [hovering, setHovering] = useState(false);
  const [zoom, setZoom] = useState(1);
  // パン(視点移動)は scroll ではなく transform で行う（キャンバスが画面に収まっていても動かせる）。
  // pan = キャンバス左上のビューポート左上からのオフセット(px)。
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [opacityDraft, setOpacityDraft] = useState<{ id: string; v: number } | null>(null);
  const [editingLayerId, setEditingLayerId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState('');
  // レイヤー D&D 中のドロップ位置ヒント（対象ノード id と、その上/下/中への挿入）。
  const [dropHint, setDropHint] = useState<{ id: string; pos: 'above' | 'below' | 'into' } | null>(
    null,
  );
  // ドラッグ中ゴーストに表示するレイヤー名（null = 非ドラッグ）。
  const [dragGhost, setDragGhost] = useState<{ name: string } | null>(null);
  // ドラッグ中の不透明度プレビュー（再レンダーを介さず合成へ反映するため ref）。
  const opacityPreviewRef = useRef<{ layerId: string; opacity: number } | null>(null);

  const previewing = histIndex !== null;
  const showCursor = tool === 'brush' || tool === 'eraser' || tool === 'line' || tool === 'rect';

  // 現在ツールの size（size を使うツールのみ。それ以外はフォールバック値）。
  const size = sizes[tool] ?? 8;
  const setSize = (v: number | ((s: number) => number)) =>
    setSizes((prev) => {
      const cur = prev[tool] ?? 8;
      const next = typeof v === 'function' ? v(cur) : v;
      return { ...prev, [tool]: Math.max(1, Math.min(80, Math.round(next))) };
    });

  const drawHighlight = (c: HTMLCanvasElement) => {
    if (!highlightRegion || highlightRegion.w <= 0 || highlightRegion.h <= 0) return;
    const ctx = c.getContext('2d');
    if (!ctx) return;
    ctx.save();
    ctx.strokeStyle = '#ffd60a';
    ctx.lineWidth = 2;
    ctx.setLineDash([6, 4]);
    ctx.strokeRect(
      highlightRegion.x + 0.5,
      highlightRegion.y + 0.5,
      Math.max(1, highlightRegion.w - 1),
      Math.max(1, highlightRegion.h - 1),
    );
    ctx.restore();
  };

  // 表示用 state（不透明度ドラッグ中はそのノードの opacity を一時的に上書き。ツリー対応）。
  const displayState = (): EditorState => {
    const pv = opacityPreviewRef.current;
    if (!pv) return session.state;
    return updateNode(session.state, pv.layerId, (n) => ({ ...n, opacity: pv.opacity }));
  };

  // Transform ツール用: アクティブレイヤー内容の bbox。layerContentBBox は全画素走査なので
  // ホバー毎ではなくここで1回だけ計算してキャッシュする（内容が空なら null）。
  const activeContentBBox = useMemo<BBox | null>(() => {
    if (tool !== 'transform') return null;
    const layer = getLayer(session.state, activeLayerId);
    if (!layer) return null;
    const bb = layerContentBBox(layer);
    return bb.w > 0 && bb.h > 0 ? bb : null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tool, version, activeLayerId]);

  // Transform ツールの枠＋頂点ハンドル描画（quad は canvas 座標の4頂点）。
  // 線幅・ハンドルはスクリーンpx 基準（zoom で割って CSS 拡大後に一定サイズに見せる）。
  const drawXformBox = (c: HTMLCanvasElement, quad: [number, number][]) => {
    const ctx = c.getContext('2d');
    if (!ctx) return;
    ctx.save();
    ctx.strokeStyle = '#56ccf2';
    ctx.lineWidth = 1.5 / zoom;
    ctx.beginPath();
    ctx.moveTo(quad[0][0], quad[0][1]);
    for (let i = 1; i < 4; i++) ctx.lineTo(quad[i][0], quad[i][1]);
    ctx.closePath();
    ctx.stroke();
    const hs = XF_HANDLE_PX / zoom;
    ctx.fillStyle = '#fff';
    ctx.lineWidth = 1 / zoom;
    for (const [x, y] of quad) {
      ctx.fillRect(x - hs / 2, y - hs / 2, hs, hs);
      ctx.strokeRect(x - hs / 2, y - hs / 2, hs, hs);
    }
    ctx.restore();
  };

  const repaint = () => {
    const c = canvasRef.current;
    if (!c || previewing) return;
    compositeToCanvas(c, displayState());
    drawHighlight(c);
    if (tool === 'transform' && activeContentBBox) drawXformBox(c, bboxCorners(activeContentBBox));
  };

  // キャンバスサイズ変更時は Replayer を作り直す（履歴スクラブ/Verify が新サイズで動くように）。
  useEffect(() => {
    replayerRef.current = new Replayer(width, height);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [width, height]);

  // マウント時・編集後(version)・選択ハイライト変更時・サイズ変更時に再描画。
  useEffect(() => {
    repaint();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version, highlightRegion, width, height]);

  // ツール・アクティブレイヤー・ズーム変更時も再描画（Transform 枠の表示有無とハンドルサイズが変わる）。
  useEffect(() => {
    repaint();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tool, activeLayerId, zoom]);

  // ツール／アクティブレイヤーが変わったら変形ストリークを終了（別対象への統合を防ぐ）。
  useEffect(() => {
    xformStreakRef.current = null;
    xformBaseStateRef.current = null;
  }, [tool, activeLayerId]);

  // checkout 等でアクティブレイヤが存在しなくなったら現在状態の active に合わせる。
  useEffect(() => {
    if (!getNode(session.state, activeLayerId)) {
      setActiveLayerId(session.state.activeLayerId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version]);

  // Variants の pull（セル→作業）等、外部からのアクティブレイヤー指定。リーフのみ受け付ける。
  useEffect(() => {
    if (!activeLayerRequest) return;
    const node = getNode(session.state, activeLayerRequest.id);
    if (node && !isGroup(node)) setActiveLayerId(activeLayerRequest.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeLayerRequest]);

  const doUndo = () => {
    if (previewing) return;
    if (session.undo()) {
      onEdit();
      repaint();
    }
  };

  const doRedo = () => {
    if (previewing) return;
    if (session.redo()) {
      onEdit();
      repaint();
    }
  };

  // ブラシカーソルのリングを pointer 位置へ追従（再レンダーを避け DOM を直接更新）。
  const moveCursor = (clientX: number, clientY: number) => {
    const ring = cursorRef.current;
    const pane = paneRef.current;
    if (!ring || !pane) return;
    const rect = pane.getBoundingClientRect();
    ring.style.left = `${clientX - rect.left}px`;
    ring.style.top = `${clientY - rect.top}px`;
  };

  // キーボードショートカット（入力欄フォーカス時は無効）。最新クロージャを ref 経由で呼ぶ。
  const kbRef = useRef<(e: KeyboardEvent) => void>(() => {});
  kbRef.current = (e: KeyboardEvent) => {
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    const meta = e.ctrlKey || e.metaKey;
    if (meta && (e.key === 'z' || e.key === 'Z')) {
      e.preventDefault();
      e.shiftKey ? doRedo() : doUndo();
      return;
    }
    if (meta && (e.key === 'y' || e.key === 'Y')) {
      e.preventDefault();
      doRedo();
      return;
    }
    if (meta) return; // 他の Ctrl/Cmd 系はブラウザに委ねる
    switch (e.key) {
      case 'b': case 'B': setTool('brush'); break;
      case 'e': case 'E': setTool('eraser'); break;
      case 'g': case 'G': setTool('bucket'); break;
      case 'i': case 'I': setTool('eyedropper'); break;
      case 'l': case 'L': setTool('line'); break;
      case 'r': case 'R': setTool('rect'); break;
      case 'v': case 'V': setTool('transform'); break;
      case 'q': case 'Q': setTool('inspect'); break;
      case '[': setSize((s) => Math.max(1, s - 2)); break;
      case ']': setSize((s) => Math.min(80, s + 2)); break;
    }
  };

  useEffect(() => {
    const h = (e: KeyboardEvent) => kbRef.current(e);
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, []);

  // S キーを押している間だけ「太さ調整モード」（MergeView と同じ操作感）。このモードでキャンバスを
  // ペン押下→上ドラッグで太く・下ドラッグで細く。入力欄フォーカス中・Ctrl/⌘併用時は無効。
  useEffect(() => {
    const isField = (t: EventTarget | null) => {
      const el = t as HTMLElement | null;
      return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);
    };
    const down = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || isField(e.target)) return;
      if (e.key === 's' || e.key === 'S') setSizeAdjust(true);
      if (e.key === 'z' || e.key === 'Z') setZoomKey(true);
    };
    const up = (e: KeyboardEvent) => {
      if (e.key === 's' || e.key === 'S') setSizeAdjust(false);
      if (e.key === 'z' || e.key === 'Z') setZoomKey(false);
    };
    const reset = () => {
      setSizeAdjust(false);
      setZoomKey(false);
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    window.addEventListener('blur', reset);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
      window.removeEventListener('blur', reset);
    };
  }, []);

  // ---- ズーム / パン（視点移動。transform のみ。ログ・画素には影響しない） ----
  const ZOOM_MIN = 0.1;
  const ZOOM_MAX = 8;
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;
  const panRef = useRef(pan);
  panRef.current = pan;
  const clampZoom = (z: number) => Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, z));

  // キャンバスが画面外に行き過ぎないよう pan を緩く制限（最低 marginだけ画面内に残す）。
  const clampPan = (p: { x: number; y: number }): { x: number; y: number } => {
    const vp = viewportRef.current;
    if (!vp) return p;
    const z = zoomRef.current;
    const cw = width * z;
    const ch = height * z;
    const m = 60;
    return {
      x: Math.max(m - cw, Math.min(vp.clientWidth - m, p.x)),
      y: Math.max(m - ch, Math.min(vp.clientHeight - m, p.y)),
    };
  };

  // キャンバスをビューポート中央に配置する pan を計算してセット。
  const centerView = (z = zoomRef.current) => {
    const vp = viewportRef.current;
    if (!vp) return;
    setPan({
      x: Math.round((vp.clientWidth - width * z) / 2),
      y: Math.round((vp.clientHeight - height * z) / 2),
    });
  };

  // anchor（スクリーン座標）を基準点に保ったままズーム。pan を調整して基準点が動かないようにする。
  const zoomToAnchor = (rawZoom: number, anchorClientX: number, anchorClientY: number) => {
    const vp = viewportRef.current;
    if (!vp) return;
    const z0 = zoomRef.current;
    const z1 = clampZoom(rawZoom);
    if (z1 === z0) return;
    const rect = vp.getBoundingClientRect();
    const ax = anchorClientX - rect.left;
    const ay = anchorClientY - rect.top;
    const p = panRef.current;
    const k = z1 / z0;
    setPan({ x: ax - (ax - p.x) * k, y: ay - (ay - p.y) * k });
    setZoom(z1);
  };

  const zoomByCenter = (factor: number) => {
    const vp = viewportRef.current;
    if (!vp) return;
    const rect = vp.getBoundingClientRect();
    zoomToAnchor(zoomRef.current * factor, rect.left + rect.width / 2, rect.top + rect.height / 2);
  };

  const resetZoom = () => {
    setZoom(1);
    centerView(1);
  };

  const fitZoom = () => {
    const vp = viewportRef.current;
    if (!vp) return;
    const z = clampZoom(Math.min((vp.clientWidth - 48) / width, (vp.clientHeight - 48) / height));
    setZoom(z);
    centerView(z);
  };

  // マウント時・キャンバスサイズ変更時に中央へ。
  useLayoutEffect(() => {
    centerView();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [width, height]);

  // Ctrl/⌘+ホイール=カーソル基準ズーム / 通常ホイール=パン（translate）。
  useEffect(() => {
    const vp = viewportRef.current;
    if (!vp) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) {
        zoomToAnchor(zoomRef.current * (e.deltaY < 0 ? 1.1 : 1 / 1.1), e.clientX, e.clientY);
      } else {
        const p = panRef.current;
        setPan(clampPan({ x: p.x - e.deltaX, y: p.y - e.deltaY }));
      }
    };
    vp.addEventListener('wheel', onWheel, { passive: false });
    return () => vp.removeEventListener('wheel', onWheel);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [width, height]);

  const getPoint = (e: ReactPointerEvent): StrokePoint => {
    const c = canvasRef.current!;
    const rect = c.getBoundingClientRect();
    const x = (e.clientX - rect.left) * (c.width / rect.width);
    const y = (e.clientY - rect.top) * (c.height / rect.height);
    const pressure = e.pointerType === 'mouse' ? 1 : e.pressure > 0 ? e.pressure : 0.5;
    return { x, y, pressure };
  };

  const sizeCanvas = (ref: MutableRefObject<HTMLCanvasElement | null>): HTMLCanvasElement => {
    let s = ref.current;
    if (!s) {
      s = document.createElement('canvas');
      ref.current = s;
    }
    if (s.width !== width || s.height !== height) {
      s.width = width;
      s.height = height;
    }
    return s;
  };

  const ensureSnapshot = (): HTMLCanvasElement => sizeCanvas(snapshotRef);

  // ストロークプレビュー。確定時とまったく同じ op を session.state に適用した結果を合成する
  // （applyOperation は純関数なので元状態は不変）。これにより:
  //   - 消しゴムは「アクティブレイヤーだけ」を消す（他レイヤーの線が消えて見える不具合の修正）
  //   - レイヤー順（上のレイヤーが手前）も正しく反映
  //   - プレビューと確定結果がピクセル一致し、手を離した瞬間に変化しない
  const renderStrokePreview = (strokes: StrokePoint[]) => {
    const c = canvasRef.current;
    if (!c) return;
    if (strokes.length === 0) {
      compositeToCanvas(c, displayState());
      drawHighlight(c);
      return;
    }
    const op =
      tool === 'eraser'
        ? createEraserOp(activeLayerId, strokes, { size, opacity }, width, height)
        : createBrushOp(
            activeLayerId,
            strokes,
            { color: hexToRgb(color), size, opacity },
            width,
            height,
          );
    compositeToCanvas(c, applyOperation(session.state, op));
    drawHighlight(c);
  };

  const drawSelectionPreview = (x0: number, y0: number, x1: number, y1: number) => {
    const c = canvasRef.current!;
    compositeToCanvas(c, session.state);
    const ctx = c.getContext('2d')!;
    ctx.save();
    ctx.strokeStyle = '#56ccf2';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([4, 3]);
    ctx.strokeRect(Math.min(x0, x1), Math.min(y0, y1), Math.abs(x1 - x0), Math.abs(y1 - y0));
    ctx.restore();
  };

  const getActiveLayer = (): Layer | undefined => getLayer(session.state, activeLayerId);

  // スポイト: 合成結果から1画素を読み、色に設定（操作はログしない読み取り専用）。
  const pickColor = (x: number, y: number) => {
    const flat = flattenState(session.state);
    const xi = Math.floor(x);
    const yi = Math.floor(y);
    if (xi < 0 || yi < 0 || xi >= flat.width || yi >= flat.height) return;
    const i = (yi * flat.width + xi) * 4;
    const hex =
      '#' +
      [flat.data[i], flat.data[i + 1], flat.data[i + 2]]
        .map((v) => v.toString(16).padStart(2, '0'))
        .join('');
    setColor(hex);
    setTool('brush'); // 採取後はブラシへ（一般的な挙動）
  };

  // 塗りつぶし: 影響領域を先に算出して region に渡し、fill 操作を適用する。
  const doFill = (x: number, y: number) => {
    if (previewing) return;
    const region = fillRegion(session.state, activeLayerId, x, y, tolerance);
    if (region.w <= 0 || region.h <= 0) return; // 種点がレイヤ外 → 何もしない（空opを残さない）
    session.apply(
      createFillOp(activeLayerId, hexToRgb(color), opacity, x, y, tolerance, region, width, height),
    );
    onEdit();
    repaint();
  };

  // 直線/矩形ツールの点列。ブラシのラスタライザが点間を補間するのでブラシ操作で再現できる。
  const shapeStrokes = (sx: number, sy: number, ex: number, ey: number): StrokePoint[] => {
    if (tool === 'line') {
      return [
        { x: sx, y: sy, pressure: 1 },
        { x: ex, y: ey, pressure: 1 },
      ];
    }
    // rect（外周）: 4隅を一周
    return [
      { x: sx, y: sy, pressure: 1 },
      { x: ex, y: sy, pressure: 1 },
      { x: ex, y: ey, pressure: 1 },
      { x: sx, y: ey, pressure: 1 },
      { x: sx, y: sy, pressure: 1 },
    ];
  };

  // Transform の当たり判定: 頂点付近=拡大縮小 / 辺上=回転 / 枠内=移動（しきい値はスクリーンpx基準）。
  const hitTransform = (x: number, y: number, bb: BBox): XformHit | null => {
    const cs = bboxCorners(bb);
    const cr = XF_CORNER_PX / zoom;
    for (let i = 0; i < 4; i++) {
      if (Math.hypot(x - cs[i][0], y - cs[i][1]) <= cr) return { mode: 'scale', corner: i };
    }
    const er = XF_EDGE_PX / zoom;
    for (let i = 0; i < 4; i++) {
      const [ax, ay] = cs[i];
      const [bx, by] = cs[(i + 1) % 4];
      if (segDist(x, y, ax, ay, bx, by) <= er) return { mode: 'rotate' };
    }
    if (x >= bb.x && x <= bb.x + bb.w && y >= bb.y && y <= bb.y + bb.h) return { mode: 'move' };
    return null;
  };

  const xformCursor = (hit: XformHit | null): string => {
    if (!hit) return 'default';
    if (hit.mode === 'move') return 'move';
    if (hit.mode === 'rotate') return 'grab';
    return hit.corner % 2 === 0 ? 'nwse-resize' : 'nesw-resize';
  };

  // ImageBuffer を実寸のオフスクリーン canvas に焼く（drawImage で GPU 変形できるように）。
  const rasterizeBuffer = (buf: ImageBuffer): HTMLCanvasElement => {
    const cv = document.createElement('canvas');
    cv.width = buf.width;
    cv.height = buf.height;
    const cx = cv.getContext('2d')!;
    const img = cx.createImageData(buf.width, buf.height);
    img.data.set(buf.data);
    cx.putImageData(img, 0, 0);
    return cv;
  };

  // ドラッグ中の高速プレビュー用キャッシュ。アクティブレイヤーがルート直下の可視リーフのとき、
  // 「下地(アクティブより下＋背景)」「上層(アクティブより上・透明背景)」「本体」を1度だけ焼く。
  // 以後はフレーム毎に setTransform + drawImage（GPU）で重ねるだけなので再サンプル/全合成が要らない。
  const xformPreviewRef = useRef<{
    below: HTMLCanvasElement;
    above: HTMLCanvasElement;
    active: HTMLCanvasElement;
    offsetX: number;
    offsetY: number;
    opacity: number;
  } | null>(null);

  const buildXformPreview = (): void => {
    xformPreviewRef.current = null;
    const layers = session.state.layers;
    const k = layers.findIndex((n) => n.id === activeLayerId);
    if (k < 0) return;
    const node = layers[k];
    if (isGroup(node) || !node.visible) return; // グループ内/非表示は決定的フォールバックに任せる
    xformPreviewRef.current = {
      below: rasterizeBuffer(flattenState({ ...session.state, layers: layers.slice(0, k) })),
      above: rasterizeBuffer(
        flattenState({ ...session.state, layers: layers.slice(k + 1) }, { background: [0, 0, 0, 0] }),
      ),
      active: rasterizeBuffer(node.buffer),
      offsetX: node.offsetX,
      offsetY: node.offsetY,
      opacity: node.opacity,
    };
  };

  // Transform ドラッグ中のプレビュー。可能なら GPU(drawImage)経路、無理ならフレーム毎の決定的経路。
  // rAF で1フレーム1回に間引く。確定結果は pointer up 時に決定的再サンプルし直す。
  const renderXformPreview = () => {
    const g = xformRef.current;
    const c = canvasRef.current;
    if (!g || !c) return;
    // 有効行列（move は平行移動）。
    const m: TransformParams =
      g.mode === 'move'
        ? { a: 1, b: 0, c: 0, d: 1, e: g.dx, f: g.dy }
        : (g.matrix ?? { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 });
    const quad = bboxCorners(g.bbox).map(
      ([x, y]) => [m.a * x + m.c * y + m.e, m.b * x + m.d * y + m.f] as [number, number],
    );

    const pv = xformPreviewRef.current;
    if (pv) {
      const ctx = c.getContext('2d');
      if (!ctx) return;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, c.width, c.height);
      ctx.drawImage(pv.below, 0, 0);
      ctx.save();
      ctx.globalAlpha = pv.opacity;
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      // setTransform(a,b,c,d,e,f) は (x,y)→(a*x+c*y+e, b*x+d*y+f)。TransformParams と一致。
      ctx.setTransform(m.a, m.b, m.c, m.d, m.e, m.f);
      ctx.drawImage(pv.active, pv.offsetX, pv.offsetY);
      ctx.restore(); // transform/alpha を identity に戻す
      ctx.drawImage(pv.above, 0, 0);
      drawXformBox(c, quad);
      return;
    }

    // フォールバック（グループ内/非表示レイヤー）: 決定的経路（重いが正確）。
    if (g.mode === 'move') {
      const preview = updateNode(session.state, activeLayerId, (n) =>
        isGroup(n) ? n : { ...n, offsetX: n.offsetX + g.dx, offsetY: n.offsetY + g.dy },
      );
      compositeToCanvas(c, preview);
      drawXformBox(c, quad);
      return;
    }
    const layer = getActiveLayer();
    if (!layer || nearIdentity(m)) {
      compositeToCanvas(c, session.state);
      drawXformBox(c, quad);
      return;
    }
    compositeToCanvas(
      c,
      applyOperation(session.state, createTransformOp(activeLayerId, m, width, height, transformedRegion(layer, m))),
    );
    drawXformBox(c, quad);
  };

  const scheduleXformPreview = () => {
    if (xformRafRef.current !== null) return;
    xformRafRef.current = requestAnimationFrame(() => {
      xformRafRef.current = null;
      renderXformPreview();
    });
  };

  // ---- ブラシ/消しゴムのドラッグ中プレビュー（増分ラスタライズ） ----
  // 旧実装は pointer move 毎に「ストローク全点を最初から再ラスタライズ＋全レイヤ全面合成」していたため、
  // 線が伸びるほど 1フレームが重くなった（O(n^2) + 毎フレーム全面合成）。透明レイヤーへ長い陰影線を
  // 何度も往復させる使い方で特に顕著だった。
  // ここでは Transform の高速プレビュー(buildXformPreview/renderXformPreview)と同じく、下地/上層を
  // down 時に1回だけ焼き、アクティブレイヤの作業バッファ(キャンバス座標)へ「新しい区間のダブだけ」を
  // 増分スタンプする。毎フレームのコストはストローク長に依存せず一定になる。
  // 確定結果は pointer up 時に従来どおり決定的に再計算する（プレビューの微小な合成誤差はそこで解消）。
  const brushPreviewRef = useRef<{
    below: HTMLCanvasElement; // アクティブより下＋背景（不透明, 1回焼き）
    above: HTMLCanvasElement; // アクティブより上（透明背景, 1回焼き）
    activeBuf: ImageBuffer; // アクティブレイヤ内容＋描画中ストローク（キャンバス座標, full-canvas）
    activeCanvas: HTMLCanvasElement; // activeBuf を putImageData で反映する 2D canvas
    activeImage: ImageData; // activeBuf.data をラップ（dirty 矩形 putImageData で再利用）
    opacity: number; // アクティブレイヤの不透明度（合成時に globalAlpha で適用）
    radius: number;
    stamp: StampFn; // ブラシ=blend / 消しゴム=erase。strokeOpacity を内包。
    last: StrokePoint | null; // 直前にスタンプした点（次区間の起点）
  } | null>(null);
  const brushRafRef = useRef<number | null>(null);

  // ドラッグ開始時に1回だけ呼ぶ。ルート直下の可視リーフのときだけ増分プレビューを構築する
  // （グループ内/非表示は false を返し、呼び出し側が従来の決定的プレビューにフォールバック）。
  const buildBrushPreview = (firstPt: StrokePoint): boolean => {
    brushPreviewRef.current = null;
    const layers = session.state.layers;
    const k = layers.findIndex((n) => n.id === activeLayerId);
    if (k < 0) return false;
    const node = layers[k];
    if (isGroup(node) || !node.visible) return false;
    // 作業バッファは activeCanvas の ImageData と同一の Uint8ClampedArray を共有させる。これにより
    // 増分スタンプの結果を putImageData の dirty 矩形でそのまま activeCanvas へ反映できる。
    const activeCanvas = document.createElement('canvas');
    activeCanvas.width = width;
    activeCanvas.height = height;
    const actx = activeCanvas.getContext('2d');
    if (!actx) return false;
    const activeImage = actx.createImageData(width, height);
    const activeBuf: ImageBuffer = { width, height, data: activeImage.data };
    // アクティブレイヤ内容をキャンバス座標へ展開（offset 適用, 範囲外は捨てる）。レイヤ不透明度は
    // 合成時に globalAlpha で掛けるため、ここでは opacity:1 で焼く。
    compositeLayer(activeBuf, { ...node, opacity: 1 });
    actx.putImageData(activeImage, 0, 0);
    const [r, g, b] = hexToRgb(color);
    const op = opacity;
    const stamp: StampFn =
      tool === 'eraser'
        ? (buf, x, y, cov) => erasePixel(buf, x, y, op * cov)
        : (buf, x, y, cov) => blendPixel(buf, x, y, r, g, b, op * cov);
    brushPreviewRef.current = {
      below: rasterizeBuffer(flattenState({ ...session.state, layers: layers.slice(0, k) })),
      above: rasterizeBuffer(
        flattenState({ ...session.state, layers: layers.slice(k + 1) }, { background: [0, 0, 0, 0] }),
      ),
      activeBuf,
      activeCanvas,
      activeImage,
      opacity: node.opacity,
      radius: size / 2,
      stamp,
      last: null,
    };
    advanceBrush(firstPt); // 先頭点を1回スタンプ
    return true;
  };

  // 新しい点 pt を作業バッファへ増分スタンプし、影響した矩形だけ activeCanvas へ反映する。
  const advanceBrush = (pt: StrokePoint) => {
    const pv = brushPreviewRef.current;
    if (!pv) return;
    if (pv.last === null) {
      stampDab(pv.activeBuf, pt, pv.radius, 0, 0, pv.stamp);
      flushBrushDirty(pv, pt, pt);
    } else {
      rasterizeSegment(pv.activeBuf, pv.last, pt, pv.radius, 0, 0, pv.stamp);
      flushBrushDirty(pv, pv.last, pt);
    }
    pv.last = pt;
  };

  // 区間 [a,b] の影響矩形（半径＋AA分パディング, キャンバスにクランプ）だけ putImageData で反映。
  const flushBrushDirty = (
    pv: NonNullable<typeof brushPreviewRef.current>,
    a: StrokePoint,
    b: StrokePoint,
  ) => {
    const pad = Math.ceil(pv.radius) + 2;
    const minX = Math.max(0, Math.floor(Math.min(a.x, b.x) - pad));
    const minY = Math.max(0, Math.floor(Math.min(a.y, b.y) - pad));
    const maxX = Math.min(width, Math.ceil(Math.max(a.x, b.x) + pad));
    const maxY = Math.min(height, Math.ceil(Math.max(a.y, b.y) + pad));
    const w = maxX - minX;
    const h = maxY - minY;
    if (w <= 0 || h <= 0) return;
    const actx = pv.activeCanvas.getContext('2d');
    if (actx) actx.putImageData(pv.activeImage, 0, 0, minX, minY, w, h);
  };

  // 下地→アクティブ(レイヤ不透明度)→上層 を GPU drawImage で重ねるだけ（全合成しない）。
  const renderBrushPreview = () => {
    const pv = brushPreviewRef.current;
    const c = canvasRef.current;
    if (!pv || !c) return;
    const ctx = c.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, c.width, c.height);
    ctx.drawImage(pv.below, 0, 0);
    ctx.save();
    ctx.globalAlpha = pv.opacity;
    ctx.drawImage(pv.activeCanvas, 0, 0);
    ctx.restore();
    ctx.drawImage(pv.above, 0, 0);
    drawHighlight(c);
  };

  const scheduleBrushPreview = () => {
    if (brushRafRef.current !== null) return;
    brushRafRef.current = requestAnimationFrame(() => {
      brushRafRef.current = null;
      renderBrushPreview();
    });
  };

  const teardownBrushPreview = () => {
    brushPreviewRef.current = null;
    if (brushRafRef.current !== null) {
      cancelAnimationFrame(brushRafRef.current);
      brushRafRef.current = null;
    }
  };

  const onPointerDown = (e: ReactPointerEvent) => {
    // 中ボタンドラッグ = パン（ツール・キャンバスが収まっているかに関係なく視点移動）。
    if (e.button === 1) {
      e.preventDefault();
      panningRef.current = { x: e.clientX, y: e.clientY, left: panRef.current.x, top: panRef.current.y };
      canvasRef.current?.setPointerCapture?.(e.pointerId);
      return;
    }
    // Z 押下中（ズームモード）: 押下位置をカーソル基準に、上下ドラッグで拡大/縮小。
    if (zoomKey) {
      e.preventDefault();
      zoomDragRef.current = { startY: e.clientY, startZoom: zoomRef.current, anchorX: e.clientX, anchorY: e.clientY };
      canvasRef.current?.setPointerCapture?.(e.pointerId);
      return;
    }
    if (previewing) return;
    const c = canvasRef.current!;
    c.setPointerCapture?.(e.pointerId);
    const pt = getPoint(e);
    // S 押下中（太さ調整モード）: 押下位置にリングを固定し、上下ドラッグで太さを変える。
    // 太さを持つツール（ブラシ/消しゴム/直線/矩形 = showCursor）のときだけ有効。
    if (sizeAdjust && showCursor) {
      sizeDragRef.current = { startY: e.clientY, startSize: size };
      moveCursor(e.clientX, e.clientY); // リングを押下位置へ固定（以後は追従させない）
      return;
    }
    if (tool === 'eyedropper') {
      pickColor(pt.x, pt.y);
    } else if (tool === 'bucket') {
      doFill(pt.x, pt.y);
    } else if (tool === 'transform') {
      const bb = activeContentBBox;
      if (!bb) return;
      const hit = hitTransform(pt.x, pt.y, bb);
      if (!hit) return;
      if (hit.mode === 'move') {
        xformRef.current = { mode: 'move', startX: pt.x, startY: pt.y, bbox: bb, dx: 0, dy: 0 };
      } else if (hit.mode === 'scale') {
        const cs = bboxCorners(bb);
        const [gx, gy] = cs[hit.corner];
        const [fx, fy] = cs[(hit.corner + 2) % 4]; // 対角の頂点を固定点にする
        xformRef.current = {
          mode: 'scale',
          corner: { x: gx, y: gy },
          fixed: { x: fx, y: fy },
          bbox: bb,
          matrix: null,
        };
      } else {
        const pivot = { x: bb.x + bb.w / 2, y: bb.y + bb.h / 2 };
        xformRef.current = {
          mode: 'rotate',
          pivot,
          startAngle: Math.atan2(pt.y - pivot.y, pt.x - pivot.x),
          bbox: bb,
          matrix: null,
        };
      }
      buildXformPreview(); // ドラッグ中の高速プレビュー用に下地/上層/本体を1度だけ焼く
      c.style.cursor = hit.mode === 'rotate' ? 'grabbing' : xformCursor(hit);
    } else if (tool === 'inspect') {
      selectRef.current = { startX: pt.x, startY: pt.y };
    } else if (tool === 'line' || tool === 'rect') {
      shapeRef.current = { startX: pt.x, startY: pt.y };
      const snap = ensureSnapshot();
      const sctx = snap.getContext('2d')!;
      sctx.clearRect(0, 0, width, height);
      sctx.drawImage(c, 0, 0);
    } else {
      // brush / eraser
      drawingRef.current = { strokes: [pt] };
      // 増分プレビューを構築（ルート直下の可視リーフのみ）。不可なら従来の決定的プレビュー。
      if (buildBrushPreview(pt)) renderBrushPreview();
      else renderStrokePreview(drawingRef.current.strokes);
    }
  };

  const onPointerMove = (e: ReactPointerEvent) => {
    if (panningRef.current) {
      const d = panningRef.current;
      setPan(clampPan({ x: d.left + (e.clientX - d.x), y: d.top + (e.clientY - d.y) }));
      if (showCursor) moveCursor(e.clientX, e.clientY); // パン中もリングカーソルを追従させる
      return;
    }
    // ズームドラッグ中: 上=拡大 / 下=縮小。押下時のカーソル位置を基準に保つ（zoomToAnchor）。
    if (zoomDragRef.current) {
      const d = zoomDragRef.current;
      zoomToAnchor(d.startZoom * Math.pow(1.01, d.startY - e.clientY), d.anchorX, d.anchorY);
      return;
    }
    // 太さ調整ドラッグ中: 上=太く / 下=細く。リングは押下位置に固定したまま大きさだけ変える。
    if (sizeDragRef.current) {
      const d = sizeDragRef.current;
      setSize(Math.round(d.startSize + (d.startY - e.clientY) * SIZE_DRAG_FACTOR));
      return;
    }
    if (showCursor) {
      moveCursor(e.clientX, e.clientY);
      // pointerEnter を取りこぼして hovering が false で固まっても、移動で表示を自己回復する
      // （setPointerCapture 解放時などに spurious な pointerLeave が出てカーソルが消える対策）。
      if (!hovering) setHovering(true);
    }
    // Transform ツールのホバー: 位置に応じてカーソルを変える（再レンダーを避け DOM 直接更新）。
    if (tool === 'transform' && !xformRef.current && !previewing) {
      const c = canvasRef.current;
      if (c) {
        const pt = getPoint(e);
        c.style.cursor = activeContentBBox
          ? xformCursor(hitTransform(pt.x, pt.y, activeContentBBox))
          : 'default';
      }
    }
    if (drawingRef.current) {
      const pt = getPoint(e);
      drawingRef.current.strokes.push(pt);
      if (brushPreviewRef.current) {
        advanceBrush(pt); // 新区間だけ増分スタンプ（軽い）
        scheduleBrushPreview(); // 合成は rAF で1フレーム1回に間引く
      } else {
        renderStrokePreview(drawingRef.current.strokes);
      }
    } else if (xformRef.current) {
      const g = xformRef.current;
      const pt = getPoint(e);
      if (g.mode === 'move') {
        g.dx = Math.round(pt.x - g.startX);
        g.dy = Math.round(pt.y - g.startY);
      } else if (g.mode === 'scale') {
        const f = g.fixed;
        if (e.shiftKey) {
          // Shift: 縦横独立（負値で反転も可）
          const sx = clampScale((pt.x - f.x) / (g.corner.x - f.x));
          const sy = clampScale((pt.y - f.y) / (g.corner.y - f.y));
          g.matrix = { a: sx, b: 0, c: 0, d: sy, e: f.x - sx * f.x, f: f.y - sy * f.y };
        } else {
          // 等比: 固定点（対角の頂点）からの距離比
          const s = clampScale(
            Math.hypot(pt.x - f.x, pt.y - f.y) / Math.hypot(g.corner.x - f.x, g.corner.y - f.y),
          );
          g.matrix = { a: s, b: 0, c: 0, d: s, e: f.x - s * f.x, f: f.y - s * f.y };
        }
      } else {
        let deg = ((Math.atan2(pt.y - g.pivot.y, pt.x - g.pivot.x) - g.startAngle) * 180) / Math.PI;
        if (e.shiftKey) deg = Math.round(deg / 15) * 15; // Shift: 15°刻みスナップ
        g.matrix = buildMatrix(1, deg, g.pivot);
      }
      scheduleXformPreview();
    } else if (selectRef.current) {
      const pt = getPoint(e);
      drawSelectionPreview(selectRef.current.startX, selectRef.current.startY, pt.x, pt.y);
    } else if (shapeRef.current) {
      const pt = getPoint(e);
      renderStrokePreview(shapeStrokes(shapeRef.current.startX, shapeRef.current.startY, pt.x, pt.y));
    }
  };

  const onPointerUp = (e: ReactPointerEvent) => {
    if (panningRef.current) {
      panningRef.current = null;
      return;
    }
    if (zoomDragRef.current) {
      zoomDragRef.current = null;
      return;
    }
    if (sizeDragRef.current) {
      sizeDragRef.current = null;
      return;
    }
    if (drawingRef.current) {
      const strokes = drawingRef.current.strokes;
      drawingRef.current = null;
      teardownBrushPreview(); // 増分プレビューのキャッシュ/保留rAFを破棄（以降は決定的 repaint）
      if (strokes.length > 0) {
        const op =
          tool === 'eraser'
            ? createEraserOp(activeLayerId, strokes, { size, opacity }, width, height)
            : createBrushOp(
                activeLayerId,
                strokes,
                { color: hexToRgb(color), size, opacity },
                width,
                height,
              );
        session.apply(op);
        onEdit();
      }
      repaint();
    } else if (xformRef.current) {
      const g = xformRef.current;
      xformRef.current = null;
      xformPreviewRef.current = null; // 高速プレビューのキャッシュを破棄
      if (xformRafRef.current !== null) {
        cancelAnimationFrame(xformRafRef.current);
        xformRafRef.current = null;
      }
      const layer = getActiveLayer();
      if (g.mode === 'move') {
        const pt = getPoint(e);
        const dx = Math.round(pt.x - g.startX);
        const dy = Math.round(pt.y - g.startY);
        if ((dx !== 0 || dy !== 0) && layer) {
          const region = unionBBox(g.bbox, {
            x: g.bbox.x + dx,
            y: g.bbox.y + dy,
            w: g.bbox.w,
            h: g.bbox.h,
          });
          // 移動は非破壊（translate）。変形ストリークは切る（次の回転は移動後から1回再サンプル）。
          xformStreakRef.current = null;
          xformBaseStateRef.current = null;
          session.apply(createTranslateOp(activeLayerId, dx, dy, width, height, region));
          onEdit();
        }
        repaint();
      } else if (layer && g.matrix && !nearIdentity(g.matrix)) {
        commitXformGesture(g.matrix); // 連続変形を統合（onEdit + repaint を含む）
      } else {
        repaint();
      }
    } else if (selectRef.current) {
      const pt = getPoint(e);
      const x0 = selectRef.current.startX;
      const y0 = selectRef.current.startY;
      selectRef.current = null;
      const bbox: BBox = {
        x: Math.min(x0, pt.x),
        y: Math.min(y0, pt.y),
        w: Math.abs(pt.x - x0),
        h: Math.abs(pt.y - y0),
      };
      if (bbox.w > 2 && bbox.h > 2) onRegionSelect(bbox);
      repaint();
    } else if (shapeRef.current) {
      const pt = getPoint(e);
      const { startX, startY } = shapeRef.current;
      shapeRef.current = null;
      // 始点と終点が同じなら何もしない（誤クリック対策）。
      if (Math.abs(pt.x - startX) > 1 || Math.abs(pt.y - startY) > 1) {
        const strokes = shapeStrokes(startX, startY, pt.x, pt.y);
        session.apply(
          createBrushOp(activeLayerId, strokes, { color: hexToRgb(color), size, opacity }, width, height),
        );
        onEdit();
      }
      repaint();
    }
  };

  // brightness/hue は「相対調整(delta)を1クリック=1操作」。影響範囲はレイヤ内容のbbox。
  const adjustBrightness = (delta: number) => {
    if (previewing) return;
    const layer = getActiveLayer();
    const region = layer ? layerContentBBox(layer) : undefined;
    session.apply(createBrightnessOp(activeLayerId, delta, width, height, region));
    onEdit();
    repaint();
  };

  const adjustHue = (shift: number) => {
    if (previewing) return;
    const layer = getActiveLayer();
    const region = layer ? layerContentBBox(layer) : undefined;
    session.apply(createHueOp(activeLayerId, shift, width, height, region));
    onEdit();
    repaint();
  };

  // ---- TRANSFORM（拡大縮小・回転・反転）。アクティブレイヤー内容を中心基準で変形する。 ----
  const pivotOf = (layer: Layer): { x: number; y: number } | null => {
    const bb = layerContentBBox(layer);
    if (bb.w <= 0 || bb.h <= 0) return null;
    return { x: bb.x + bb.w / 2, y: bb.y + bb.h / 2 };
  };

  // scale(s, 中心 pivot) と rotate(deg) を合成したキャンバス座標アフィン行列。
  const buildMatrix = (s: number, deg: number, pivot: { x: number; y: number }): TransformParams => {
    const rad = (deg * Math.PI) / 180;
    const a = Math.cos(rad) * s;
    const b = Math.sin(rad) * s;
    const c = -Math.sin(rad) * s;
    const d = Math.cos(rad) * s;
    return {
      a,
      b,
      c,
      d,
      e: pivot.x - (a * pivot.x + c * pivot.y),
      f: pivot.y - (b * pivot.x + d * pivot.y),
    };
  };

  // 変換後の内容 bbox（依存判定 region 用）。
  const transformedRegion = (layer: Layer, m: TransformParams): BBox => {
    const { offsetX: ox, offsetY: oy, buffer } = layer;
    const pts: [number, number][] = [
      [ox, oy],
      [ox + buffer.width, oy],
      [ox + buffer.width, oy + buffer.height],
      [ox, oy + buffer.height],
    ];
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const [x, y] of pts) {
      const dx = m.a * x + m.c * y + m.e;
      const dy = m.b * x + m.d * y + m.f;
      if (dx < minX) minX = dx;
      if (dx > maxX) maxX = dx;
      if (dy < minY) minY = dy;
      if (dy > maxY) maxY = dy;
    }
    return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
  };

  // 90°回転・反転ボタン用の単発確定（ストリークは切る）。
  const applyTransformMatrix = (m: TransformParams, layer: Layer) => {
    session.apply(createTransformOp(activeLayerId, m, width, height, transformedRegion(layer, m)));
    xformStreakRef.current = null;
    xformBaseStateRef.current = null;
    onEdit();
    repaint();
  };

  // Transform ツールのジェスチャ確定。m は「現在の表示内容 → 変形後」のキャンバス座標アフィン。
  // 直前の確定が同一ストリークの変形なら、行列を合成して「ストリーク開始時の状態」から
  // 1回だけ再サンプルし直し、末尾 op を置き換える（amendLast）。全ログ replay を避けるため軽い。
  // これによりバッファ肥大も再サンプル累積（解像度低下）も起きない。
  const commitXformGesture = (m: TransformParams) => {
    const log = session.getLog();
    const last = log[log.length - 1];
    const streak = xformStreakRef.current;
    const baseState = xformBaseStateRef.current;
    const baseLayer = baseState ? getLayer(baseState, activeLayerId) : undefined;
    const continues =
      !!streak && !!last && last.id === streak.opId && last.type === 'transform' &&
      last.layerId === activeLayerId && !!baseState && !!baseLayer;
    if (continues) {
      const cumulative = composeMatrix(m, streak!.cumulative);
      const op = createTransformOp(activeLayerId, cumulative, width, height, transformedRegion(baseLayer!, cumulative));
      const newState = applyOperation(baseState!, op); // 元バッファから1回だけ再サンプル（replay 不要）
      session.amendLast(op, newState);
      xformStreakRef.current = { opId: op.id, cumulative };
    } else {
      const base = getActiveLayer();
      if (!base) {
        repaint();
        return;
      }
      xformBaseStateRef.current = session.state; // ストリーク開始時の状態を控える（構造共有で軽量）
      const op = createTransformOp(activeLayerId, m, width, height, transformedRegion(base, m));
      session.apply(op);
      xformStreakRef.current = { opId: op.id, cumulative: m };
    }
    onEdit();
    repaint();
  };

  const applyRotate90 = (dir: 1 | -1) => {
    if (previewing) return;
    const layer = getActiveLayer();
    const pivot = layer ? pivotOf(layer) : null;
    if (!layer || !pivot) return;
    applyTransformMatrix(buildMatrix(1, dir * 90, pivot), layer);
  };

  const applyFlip = (axis: 'h' | 'v') => {
    if (previewing) return;
    const layer = getActiveLayer();
    const pivot = layer ? pivotOf(layer) : null;
    if (!layer || !pivot) return;
    const a = axis === 'h' ? -1 : 1;
    const d = axis === 'v' ? -1 : 1;
    applyTransformMatrix({ a, b: 0, c: 0, d, e: pivot.x - a * pivot.x, f: pivot.y - d * pivot.y }, layer);
  };

  const addLayer = () => {
    if (previewing) return;
    const id = genId('layer');
    const name = `Layer ${session.state.layers.length}`;
    session.apply(createAddLayerOp(id, name, width, height));
    setActiveLayerId(id);
    onEdit();
    repaint();
  };

  // 画像を新規レイヤとして読み込む。キャンバスに収まるよう縮小し、中央に配置する。
  // 画素は addImageLayer 操作に焼き込まれ、log だけから決定的に再構築できる。
  const importImage = (file: File) => {
    if (previewing) return;
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      const scale = Math.min(width / img.width, height / img.height, 1);
      const w = Math.max(1, Math.round(img.width * scale));
      const h = Math.max(1, Math.round(img.height * scale));
      const off = document.createElement('canvas');
      off.width = w;
      off.height = h;
      const octx = off.getContext('2d');
      if (!octx) return;
      octx.drawImage(img, 0, 0, w, h);
      const px = octx.getImageData(0, 0, w, h);
      const buffer: ImageBuffer = { width: w, height: h, data: px.data };
      const id = genId('layer');
      const name = file.name.replace(/\.[^.]+$/, '') || `Image ${session.state.layers.length}`;
      const offsetX = Math.floor((width - w) / 2);
      const offsetY = Math.floor((height - h) / 2);
      session.apply(createAddImageLayerOp(id, name, buffer, offsetX, offsetY, width, height));
      setActiveLayerId(id);
      onEdit();
      repaint();
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      alert('画像の読み込みに失敗しました。');
    };
    img.src = url;
  };

  // 現在の合成結果を PNG として書き出す（オーバーレイなしの純粋な合成）。
  const exportPng = () => {
    const off = document.createElement('canvas');
    compositeToCanvas(off, session.state);
    off.toBlob((blob) => {
      if (!blob) return;
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'image.png';
      a.click();
      URL.revokeObjectURL(url);
    }, 'image/png');
  };

  // レイヤー構造ごと PSD で書き出す（Photoshop / Clip Studio で開ける）。
  // ag-psd は重いので動的 import で必要時のみ読み込む（初期ロードを軽く保つ）。
  const exportPsd = async () => {
    try {
      const { exportStateToPsd } = await import('./psdExport');
      const buf = exportStateToPsd(session.state);
      const blob = new Blob([buf], { type: 'application/octet-stream' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'image.psd';
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error(err);
      alert('PSD の書き出しに失敗しました。');
    }
  };

  // ノードの影響領域（リーフは内容bbox、グループは省略=空）。
  const nodeRegion = (n: LayerNode) => (isGroup(n) ? undefined : layerContentBBox(n));
  const leafCount = () => session.state.layers.flatMap(collectLeafIds).length;

  const toggleVisibility = (n: LayerNode) => {
    if (previewing) return;
    session.apply(createSetLayerVisibilityOp(n.id, !n.visible, nodeRegion(n)));
    onEdit();
    repaint();
  };

  const deleteLayer = (n: LayerNode) => {
    if (previewing) return;
    if (leafCount() - collectLeafIds(n).length < 1) return; // 最低1リーフを残す
    session.apply(createRemoveLayerOp(n.id, nodeRegion(n)));
    setActiveLayerId(session.state.activeLayerId);
    onEdit();
    repaint();
  };

  // アクティブレイヤーの内容を全消去（透明化）。1操作として記録され Undo 可能。
  const clearActiveLayer = () => {
    if (previewing) return;
    const layer = getActiveLayer();
    if (!layer) return;
    session.apply(createClearLayerOp(layer.id, width, height, layerContentBBox(layer)));
    onEdit();
    repaint();
  };

  // 下のレイヤーと統合（merge down）。同じ親内の隣接リーフ同士のみ。
  const canMergeDown = (n: LayerNode): boolean => {
    if (isGroup(n)) return false;
    const info = getParentInfo(session.state, n.id);
    if (!info || info.index <= 0) return false;
    return !isGroup(info.siblings[info.index - 1]);
  };
  const mergeDown = (n: LayerNode) => {
    if (previewing || !canMergeDown(n)) return;
    const info = getParentInfo(session.state, n.id)!;
    const lower = info.siblings[info.index - 1] as Layer;
    const region = unionBBox(layerContentBBox(n as Layer), layerContentBBox(lower));
    session.apply(createMergeDownLayerOp(n.id, region));
    setActiveLayerId(session.state.activeLayerId);
    onEdit();
    repaint();
  };

  // ---- レイヤーの D&D（並べ替え / フォルダ出し入れ）。▲▼ ボタンと 📁→ 選択の代替。 ----
  // ネイティブ HTML5 D&D はマウス専用でペン/タッチで発火しないため、pointer イベントで自作する。
  // 表示は上=最前面で逆順描画するので、視覚上の「above（上）」は配列では index 大（後ろ）になる。

  // 追従する半透明ゴーストを pointer 位置へ移動（再レンダーを避け DOM 直接更新）。
  const positionGhost = (clientX: number, clientY: number) => {
    const g = ghostRef.current;
    if (g) {
      g.style.left = `${clientX + 12}px`;
      g.style.top = `${clientY + 8}px`;
    }
  };

  const onGripPointerDown = (n: LayerNode, e: ReactPointerEvent) => {
    if (previewing) return;
    e.preventDefault();
    e.stopPropagation();
    dragIdRef.current = n.id;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    positionGhost(e.clientX, e.clientY);
    setDragGhost({ name: n.name });
  };

  // pointer 位置の直下にあるレイヤー行を判定し、上/中/下のドロップ位置ヒントを更新する。
  const onGripPointerMove = (e: ReactPointerEvent) => {
    const dragged = dragIdRef.current;
    if (!dragged) return;
    positionGhost(e.clientX, e.clientY);
    const head = (document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null)?.closest(
      '.layer-head',
    ) as HTMLElement | null;
    const targetId = head?.dataset.id;
    const tn = targetId ? getNode(session.state, targetId) : undefined;
    const dn = getNode(session.state, dragged);
    if (!head || !targetId || !tn || targetId === dragged || (dn && collectNodeIds(dn).includes(targetId))) {
      setDropHint((p) => (p ? null : p));
      return;
    }
    const rect = head.getBoundingClientRect();
    const r = (e.clientY - rect.top) / Math.max(1, rect.height);
    const pos: 'above' | 'below' | 'into' = isGroup(tn)
      ? r < 0.28
        ? 'above'
        : r > 0.72
          ? 'below'
          : 'into'
      : r < 0.5
        ? 'above'
        : 'below';
    setDropHint((p) => (p && p.id === targetId && p.pos === pos ? p : { id: targetId, pos }));
  };

  const onGripPointerUp = (e: ReactPointerEvent) => {
    const dragged = dragIdRef.current;
    const hint = dropHint;
    try {
      (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    } catch {
      /* 既に解放済み */
    }
    dragIdRef.current = null;
    setDragGhost(null);
    setDropHint(null);
    if (previewing || !dragged) return;
    if (hint) {
      performDrop(dragged, hint.id, hint.pos);
    } else {
      // 行(.layer-head)の上でなく、レイヤーリストの余白で離したときだけ最上位の最前面へ（フォルダから
      // 出す手段）。行上でのリリース（＝動かさずクリックした場合含む）は no-op にする。
      const over = document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null;
      if (over && !over.closest('.layer-head') && over.closest('.layer-list') && getNode(session.state, dragged)) {
        session.apply(createMoveNodeOp(dragged, null, Number.MAX_SAFE_INTEGER));
        onEdit();
        repaint();
      }
    }
  };

  const performDrop = (draggedId: string, targetId: string, pos: 'above' | 'below' | 'into') => {
    if (previewing || draggedId === targetId) return;
    const dn = getNode(session.state, draggedId);
    const tn = getNode(session.state, targetId);
    if (!dn || !tn || collectNodeIds(dn).includes(targetId)) return; // 子孫へは不可
    if (pos === 'into') {
      session.apply(createMoveNodeOp(draggedId, targetId, Number.MAX_SAFE_INTEGER)); // フォルダ先頭(最前面)へ
    } else {
      const info = getParentInfo(session.state, targetId);
      if (!info) return;
      const from = getParentInfo(session.state, draggedId);
      const sameParent = from && from.parentId === info.parentId ? from.index : null;
      session.apply(
        createMoveNodeOp(draggedId, info.parentId, reorderIndex(pos, info.index, sameParent)),
      );
    }
    onEdit();
    repaint();
  };

  const startRename = (n: LayerNode) => {
    setEditingLayerId(n.id);
    setEditingName(n.name);
  };

  const commitRename = (n: LayerNode) => {
    const name = editingName.trim();
    setEditingLayerId(null);
    if (name && name !== n.name) {
      session.apply(createRenameLayerOp(n.id, name));
      onEdit();
      repaint();
    }
  };

  const toggleCollapse = (g: LayerGroup) => {
    session.apply(createSetGroupCollapsedOp(g.id, !g.collapsed));
    onEdit();
  };

  // 空フォルダを最上位に追加。
  const addFolder = () => {
    if (previewing) return;
    session.apply(createAddGroupOp(genId('group'), `Folder ${session.state.layers.length}`));
    onEdit();
    repaint();
  };

  // アクティブレイヤーをその場でフォルダに包む。
  const groupActiveLayer = () => {
    if (previewing) return;
    const layer = getActiveLayer();
    if (!layer) return;
    session.apply(createAddGroupOp(genId('group'), 'Folder', layer.id));
    onEdit();
    repaint();
  };

  // レイヤー名クリック: グループは開閉、リーフは選択。Ctrl/⌘ で複数選択にトグル追加。
  const onLayerClick = (n: LayerNode, e: ReactMouseEvent) => {
    if (isGroup(n)) {
      toggleCollapse(n);
      return;
    }
    setActiveLayerId(n.id);
    if (e.ctrlKey || e.metaKey) {
      setSelectedLayerIds((prev) => {
        const s = new Set(prev);
        s.has(n.id) ? s.delete(n.id) : s.add(n.id);
        return s;
      });
    } else {
      setSelectedLayerIds(new Set([n.id]));
    }
  };

  // 選択中のレイヤー群から「選択式(slotless)」の Variants 軸を作る（フォルダ不要）。
  const createAxisFromSelection = () => {
    if (previewing || selectedLayerIds.size === 0) return;
    session.addAxisFromLayers('', [...selectedLayerIds]);
    setSelectedLayerIds(new Set());
    onEdit();
  };

  const onOpacityInput = (n: LayerNode, v: number) => {
    setOpacityDraft({ id: n.id, v });
    opacityPreviewRef.current = { layerId: n.id, opacity: v };
    const c = canvasRef.current;
    if (c && !previewing) {
      compositeToCanvas(c, displayState());
      drawHighlight(c);
    }
  };

  const commitOpacity = (n: LayerNode) => {
    const pv = opacityPreviewRef.current;
    opacityPreviewRef.current = null;
    setOpacityDraft(null);
    if (pv && pv.layerId === n.id && Math.abs(pv.opacity - n.opacity) > 1e-6) {
      session.apply(createSetLayerOpacityOp(n.id, pv.opacity, nodeRegion(n)));
      onEdit();
    }
    repaint();
  };

  // レイヤーツリーを再帰描画（フォルダは折りたたみ可。表示は上=最前面なので reverse）。
  const renderNode = (n: LayerNode, depth: number, siblings: LayerNode[]) => {
    const grp = isGroup(n) ? n : null;
    const leaf = grp ? null : (n as Layer);
    const editing = editingLayerId === n.id;
    const active = !grp && n.id === activeLayerId;
    const selected = !grp && selectedLayerIds.has(n.id);
    const disableDelete = previewing || leafCount() - collectLeafIds(n).length < 1;
    const dropCls = dropHint?.id === n.id ? ` drop-${dropHint.pos}` : '';
    return (
      <li
        key={n.id}
        className={`layer-item ${grp ? 'is-group' : ''} ${active ? 'active' : ''} ${
          selected ? 'selected' : ''
        }${dropCls}`}
      >
        <div className="layer-head" data-id={n.id} style={{ paddingLeft: 4 + depth * 12 }}>
          <span
            className="layer-grip"
            title="ドラッグで並べ替え / フォルダへ出し入れ"
            onPointerDown={(e) => onGripPointerDown(n, e)}
            onPointerMove={onGripPointerMove}
            onPointerUp={onGripPointerUp}
            onPointerCancel={onGripPointerUp}
          >
            ⠿
          </span>
          {grp ? (
            <button
              className="icon-btn"
              title={grp.collapsed ? '展開' : '折りたたみ'}
              onClick={() => toggleCollapse(grp)}
            >
              {grp.collapsed ? '▸' : '▾'}
            </button>
          ) : (
            <span className="layer-indent" />
          )}
          <button
            className="icon-btn"
            title={n.visible ? '表示中（クリックで非表示）' : '非表示（クリックで表示）'}
            disabled={previewing}
            onClick={() => toggleVisibility(n)}
          >
            {n.visible ? '👁' : '🚫'}
          </button>
          {editing ? (
            <input
              className="layer-name-input"
              autoFocus
              value={editingName}
              onChange={(e) => setEditingName(e.target.value)}
              onBlur={() => commitRename(n)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commitRename(n);
                else if (e.key === 'Escape') setEditingLayerId(null);
              }}
            />
          ) : (
            <span
              className="layer-name"
              onClick={(e) => onLayerClick(n, e)}
              onDoubleClick={() => startRename(n)}
              title="クリックで選択/開閉 / Ctrl・⌘+クリックで複数選択 / ダブルクリックで名称変更"
            >
              {grp ? '📁 ' : ''}
              {n.name}
              {leaf && (leaf.offsetX !== 0 || leaf.offsetY !== 0) && (
                <span className="muted">
                  {' '}
                  @({leaf.offsetX},{leaf.offsetY})
                </span>
              )}
            </span>
          )}
          <span className="layer-actions">
            {!grp && (
              <button
                className="icon-btn"
                title="下のレイヤーと統合 (merge down)"
                disabled={previewing || !canMergeDown(n)}
                onClick={() => mergeDown(n)}
              >
                ⤓
              </button>
            )}
            <button className="icon-btn" title="削除" disabled={disableDelete} onClick={() => deleteLayer(n)}>
              🗑
            </button>
          </span>
        </div>
        {grp && !grp.collapsed && (
          <ul className="layer-list nested">
            {grp.children
              .slice()
              .reverse()
              .map((c) => renderNode(c, depth + 1, grp.children))}
          </ul>
        )}
      </li>
    );
  };

  const reset = () => {
    session.reset();
    setActiveLayerId(session.state.activeLayerId);
    setHistIndex(null);
    setVerify(null);
    onEdit();
    repaint();
  };

  const log = session.getLog();

  const indexById = new Map<string, number>();
  log.forEach((op, i) => indexById.set(op.id, i));
  const parentLabels = (op: Operation): string => {
    const node = dag.nodes.get(op.id);
    if (!node) return '';
    return node.parents
      .map((pid) => (pid === ROOT_ID ? 'root' : `#${indexById.get(pid)}`))
      .join(', ');
  };

  const onScrub = (k: number) => {
    if (k >= log.length) {
      setHistIndex(null);
      // setHistIndex は次レンダーで反映されるため、ここで即ライブ描画する。
      const c = canvasRef.current;
      if (c) {
        compositeToCanvas(c, session.state);
        drawHighlight(c);
      }
    } else {
      setHistIndex(k);
      compositeToCanvas(canvasRef.current!, replayerRef.current!.replay(log, k));
    }
  };

  const returnToLatest = () => {
    setHistIndex(null);
    const c = canvasRef.current;
    if (c) {
      compositeToCanvas(c, session.state);
      drawHighlight(c);
    }
  };

  const runVerify = () => {
    const replayed = replayerRef.current!.replay(session.getLog());
    const ok = statesEqual(replayed, session.state);
    setVerify({
      ok,
      msg: ok
        ? `OK — ${log.length} 操作の replay がライブ状態とビット一致`
        : 'NG — replay がライブ状態と不一致',
    });
  };

  return (
    <div className="editor" ref={paneRef}>
      <div className={`canvas-viewport ${zoomKey ? 'zoom-mode' : ''}`} ref={viewportRef}>
        <div className="canvas-pan" style={{ transform: `translate(${pan.x}px, ${pan.y}px)` }}>
          <canvas
            ref={canvasRef}
            className="edit-canvas"
            width={width}
            height={height}
            style={{
              width: width * zoom,
              height: height * zoom,
              touchAction: 'none',
              cursor: showCursor ? 'none' : 'crosshair',
              imageRendering: zoom >= 2 ? 'pixelated' : 'auto',
            }}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
            onPointerEnter={(e) => {
              setHovering(true);
              moveCursor(e.clientX, e.clientY);
            }}
            onPointerLeave={() => setHovering(false)}
          />
        </div>
      </div>

      <div
        ref={cursorRef}
        className={`brush-cursor ${sizeAdjust ? 'sizing' : ''}`}
        style={{
          width: size * zoom,
          height: size * zoom,
          display: showCursor && hovering && !previewing ? 'block' : 'none',
          borderColor: sizeAdjust ? '#56ccf2' : tool === 'eraser' ? '#fff' : color,
        }}
      >
        {sizeAdjust && <span className="brush-cursor-label">{size}px</span>}
      </div>

      {/* レイヤー D&D 中に pointer へ追従する半透明ゴースト（マウス/ペン/タッチ共通）。 */}
      <div ref={ghostRef} className="layer-drag-ghost" style={{ display: dragGhost ? 'block' : 'none' }}>
        {dragGhost?.name}
      </div>

      {previewing && (
        <div className="preview-banner">
          履歴を閲覧中（読み取り専用）— step {histIndex}/{log.length}
          <button onClick={returnToLatest}>最新に戻る</button>
        </div>
      )}

      {/* キャンバス下部のフロートバー: ズーム + 履歴スクラブ */}
      <div className="float-canvasbar">
        <button onClick={() => zoomByCenter(1 / 1.25)} title="縮小">−</button>
        <span className="zoom-val" onClick={resetZoom} title="クリックで100%">
          {Math.round(zoom * 100)}%
        </span>
        <button onClick={() => zoomByCenter(1.25)} title="拡大">＋</button>
        <button onClick={resetZoom}>100%</button>
        <button onClick={fitZoom}>Fit</button>
        <span className={`keyhint-badge ${zoomKey ? 'on' : ''}`} title="Z を押しながらキャンバスを上下ドラッグでズーム">
          Z＋上下ドラッグ＝ズーム
        </span>
        <span className="cb-sep" />
        <span className="history-label">history</span>
        <input
          type="range"
          min={0}
          max={log.length}
          value={histIndex ?? log.length}
          onChange={(e) => onScrub(Number(e.target.value))}
          disabled={log.length === 0}
        />
        <span className="history-step">
          {histIndex === null ? `latest (${log.length})` : `${histIndex}/${log.length}`}
        </span>
      </div>

      <FloatWindow id="nrc-tools" title="Tools" defaultPos={{ left: 12, top: 12 }} className="float-tools">
        <Section title="TOOLS" defaultOpen>
          <div className="tool-row">
            <button onClick={doUndo} disabled={!session.canUndo() || previewing} title="Undo (Ctrl+Z)">
              ↶ Undo
            </button>
            <button
              onClick={doRedo}
              disabled={!session.canRedo() || previewing}
              title="Redo (Ctrl+Shift+Z)"
            >
              ↷ Redo
            </button>
          </div>
          <div className="tool-row">
            {TOOLS.map((t) => (
              <button
                key={t.id}
                className={tool === t.id ? 'active' : ''}
                onClick={() => setTool(t.id)}
                title={`${t.label} (${t.key})`}
              >
                {t.label} <span className="key-hint">{t.key}</span>
              </button>
            ))}
          </div>
          {showCursor && (
            <>
              <label className="field">
                <span>
                  {tool} size {size}px
                </span>
                <input
                  type="range"
                  min={1}
                  max={80}
                  value={size}
                  onChange={(e) => setSize(Number(e.target.value))}
                />
              </label>
              <span className={`keyhint-badge ${sizeAdjust ? 'on' : ''}`}>
                S 押下＋キャンバスを上下ドラッグ＝太さ調整
              </span>
            </>
          )}
          <label className="field">
            <span>opacity {opacity.toFixed(2)}</span>
            <input
              type="range"
              min={0.05}
              max={1}
              step={0.05}
              value={opacity}
              onChange={(e) => setOpacity(Number(e.target.value))}
            />
          </label>
          {tool === 'bucket' && (
            <label className="field">
              <span>fill tolerance {tolerance}</span>
              <input
                type="range"
                min={0}
                max={128}
                value={tolerance}
                onChange={(e) => setTolerance(Number(e.target.value))}
              />
            </label>
          )}
          {tool === 'transform' && (
            <p className="hint">
              枠内ドラッグ=移動／頂点□=拡大縮小（Shift で縦横独立）／辺=回転（Shift で15°刻み）。
              1ドラッグ = 1操作として記録されます。
            </p>
          )}
          <p className="hint">
            B=Brush E=Eraser G=Fill I=Pick L=Line R=Rect V=Transform Q=Inspect／
            S押下＋上下ドラッグ or [ ]=サイズ／Ctrl+Z=Undo Ctrl+Shift+Z=Redo
          </p>
        </Section>

        <Section title="COLOR" defaultOpen>
          <ColorPicker color={color} onChange={setColor} />
        </Section>

        <Section title="ADJUST" defaultOpen={false}>
          <div className="field">
            <span>brightness</span>
            <div className="btn-group">
              {[-40, -10, 10, 40].map((d) => (
                <button key={d} disabled={previewing} onClick={() => adjustBrightness(d)}>
                  {d > 0 ? `+${d}` : d}
                </button>
              ))}
            </div>
          </div>
          <div className="field">
            <span>hue</span>
            <div className="btn-group">
              {[-45, -15, 15, 45].map((d) => (
                <button key={d} disabled={previewing} onClick={() => adjustHue(d)}>
                  {d > 0 ? `+${d}°` : `${d}°`}
                </button>
              ))}
            </div>
          </div>
          <p className="hint">対象レイヤへの相対調整。1クリック = 1操作として記録されます。</p>
        </Section>

        <Section title="TRANSFORM" defaultOpen={false}>
          <div className="tool-row">
            <button onClick={() => applyRotate90(-1)} disabled={previewing} title="左に90°回転">
              ⟲ 90°
            </button>
            <button onClick={() => applyRotate90(1)} disabled={previewing} title="右に90°回転">
              ⟳ 90°
            </button>
            <button onClick={() => applyFlip('h')} disabled={previewing} title="左右反転">
              Flip H
            </button>
            <button onClick={() => applyFlip('v')} disabled={previewing} title="上下反転">
              Flip V
            </button>
          </div>
          <p className="hint">
            ワンクリック変形（アクティブレイヤー、中心基準）。自由な移動・拡大縮小・回転は
            Transform ツール（V）でキャンバス上の枠をドラッグ。
          </p>
        </Section>

        <Section title="LAYERS" defaultOpen>
          <div className="tool-row">
            <button onClick={addLayer} disabled={previewing}>
              + Layer
            </button>
            <button onClick={addFolder} disabled={previewing} title="空のフォルダを最上位に追加">
              + Folder
            </button>
            <button
              onClick={groupActiveLayer}
              disabled={previewing}
              title="アクティブレイヤーを新規フォルダで包む（中身入りフォルダを一発で作る）"
            >
              Wrap
            </button>
            <button onClick={() => imageInputRef.current?.click()} disabled={previewing}>
              Import
            </button>
            <button onClick={exportPng} title="現在の合成を PNG 保存">
              PNG
            </button>
            <button onClick={exportPsd} title="レイヤー構造ごと PSD で書き出し（Photoshop / Clip Studio で開ける）">
              PSD
            </button>
            <button onClick={clearActiveLayer} disabled={previewing} title="アクティブレイヤーを全消去">
              Clear
            </button>
            <button
              onClick={createAxisFromSelection}
              disabled={previewing || selectedLayerIds.size === 0}
              title="選択したレイヤーを別案セルとして新しい Variants 軸に登録（フォルダ不要）"
            >
              → Variants ({selectedLayerIds.size})
            </button>
          </div>
          <input
            ref={imageInputRef}
            type="file"
            accept="image/*"
            style={{ display: 'none' }}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) importImage(f);
              e.target.value = '';
            }}
          />
          {(() => {
            // アクティブレイヤー1つに対する不透明度スライダー（各行から集約）。
            const al = getActiveLayer();
            const v = al ? (opacityDraft?.id === al.id ? opacityDraft.v : al.opacity) : 1;
            return (
              <div className="layer-active-opacity">
                <span className="muted">不透明度</span>
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.05}
                  value={v}
                  disabled={!al || previewing}
                  onChange={(e) => al && onOpacityInput(al, Number(e.target.value))}
                  onPointerUp={() => al && commitOpacity(al)}
                  onBlur={() => al && commitOpacity(al)}
                  onKeyUp={() => al && commitOpacity(al)}
                />
                <span className="layer-opacity-val">{Math.round(v * 100)}%</span>
              </div>
            );
          })()}
          <ul className="layer-list">
            {session.state.layers
              .slice()
              .reverse()
              .map((n) => renderNode(n, 0, session.state.layers))}
          </ul>
          <p className="hint">⠿ をドラッグで並べ替え（ペン/タッチ可）。フォルダの中央に落とすと収納、余白に落とすと最上位へ。</p>
        </Section>

        <Section title={`LOG (${log.length})`} defaultOpen={false}>
          <div className="tool-row">
            <button onClick={runVerify} disabled={log.length === 0}>
              Verify replay
            </button>
            <button onClick={reset}>Reset</button>
          </div>
          {verify && <p className={verify.ok ? 'verify ok' : 'verify ng'}>{verify.msg}</p>}
          <ol className="op-log">
            {log.map((op, i) => (
              <li
                key={op.id}
                className={`op op-${op.klass} ${previewing && i >= histIndex! ? 'op-future' : ''}`}
              >
                <span className="op-index">{i}</span>
                <span className="op-type">{op.type}</span>
                <span className="op-desc">{describeOp(op)}</span>
                <span className="op-parents">← {parentLabels(op)}</span>
              </li>
            ))}
          </ol>
        </Section>
      </FloatWindow>
    </div>
  );
}
