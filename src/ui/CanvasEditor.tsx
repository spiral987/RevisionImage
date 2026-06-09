import { useEffect, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import type { BBox, Dag, EditorState, ImageBuffer, Layer, Operation, StrokePoint } from '../types';
import type { EditorSession } from '../session';
import { statesEqual } from '../engine/compare';
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
  createFillOp,
  fillRegion,
} from '../engine/operations';
import { genId } from '../util/id';
import { layerContentBBox } from '../engine/layer';
import { flattenState } from '../engine/composite';
import { unionBBox } from '../engine/geom';
import { compositeToCanvas } from './render';
import { describeOp } from './opLabel';

type Tool =
  | 'brush'
  | 'eraser'
  | 'bucket'
  | 'eyedropper'
  | 'line'
  | 'rect'
  | 'translate'
  | 'select';

const TOOLS: { id: Tool; label: string; key: string }[] = [
  { id: 'brush', label: 'Brush', key: 'B' },
  { id: 'eraser', label: 'Eraser', key: 'E' },
  { id: 'bucket', label: 'Fill', key: 'G' },
  { id: 'eyedropper', label: 'Pick', key: 'I' },
  { id: 'line', label: 'Line', key: 'L' },
  { id: 'rect', label: 'Rect', key: 'R' },
  { id: 'translate', label: 'Move', key: 'V' },
  { id: 'select', label: 'Select', key: 'S' },
];

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
}: {
  session: EditorSession;
  width: number;
  height: number;
  version: number;
  dag: Dag;
  onEdit: () => void;
  highlightRegion: BBox | null;
  onRegionSelect: (bbox: BBox) => void;
}) {
  const replayerRef = useRef<Replayer | null>(null);
  if (!replayerRef.current) replayerRef.current = new Replayer(width, height);
  const replayer = replayerRef.current;

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const paneRef = useRef<HTMLDivElement>(null);
  const cursorRef = useRef<HTMLDivElement>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const snapshotRef = useRef<HTMLCanvasElement | null>(null);
  const drawingRef = useRef<{ strokes: StrokePoint[] } | null>(null);
  const dragRef = useRef<{ startX: number; startY: number } | null>(null);
  const selectRef = useRef<{ startX: number; startY: number } | null>(null);
  const shapeRef = useRef<{ startX: number; startY: number } | null>(null);

  const [tool, setTool] = useState<Tool>('brush');
  const [color, setColor] = useState('#e23b3b');
  const [size, setSize] = useState(14);
  const [opacity, setOpacity] = useState(1);
  const [tolerance, setTolerance] = useState(24);
  const [activeLayerId, setActiveLayerId] = useState(session.state.activeLayerId);
  const [histIndex, setHistIndex] = useState<number | null>(null);
  const [verify, setVerify] = useState<{ ok: boolean; msg: string } | null>(null);
  const [hovering, setHovering] = useState(false);
  const [opacityDraft, setOpacityDraft] = useState<{ id: string; v: number } | null>(null);
  const [editingLayerId, setEditingLayerId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState('');
  // ドラッグ中の不透明度プレビュー（再レンダーを介さず合成へ反映するため ref）。
  const opacityPreviewRef = useRef<{ layerId: string; opacity: number } | null>(null);

  const previewing = histIndex !== null;
  const showCursor = tool === 'brush' || tool === 'eraser' || tool === 'line' || tool === 'rect';

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

  // 表示用 state（不透明度ドラッグ中はそのレイヤの opacity を一時的に上書き）。
  const displayState = (): EditorState => {
    const pv = opacityPreviewRef.current;
    if (!pv) return session.state;
    return {
      ...session.state,
      layers: session.state.layers.map((l) =>
        l.id === pv.layerId ? { ...l, opacity: pv.opacity } : l,
      ),
    };
  };

  const repaint = () => {
    const c = canvasRef.current;
    if (!c || previewing) return;
    compositeToCanvas(c, displayState());
    drawHighlight(c);
  };

  // マウント時・編集後(version)・選択ハイライト変更時に再描画。
  useEffect(() => {
    repaint();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version, highlightRegion]);

  // checkout 等でアクティブレイヤが存在しなくなったら現在状態の active に合わせる。
  useEffect(() => {
    if (!session.state.layers.some((l) => l.id === activeLayerId)) {
      setActiveLayerId(session.state.activeLayerId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version]);

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
      case 'v': case 'V': setTool('translate'); break;
      case 's': case 'S': setTool('select'); break;
      case '[': setSize((s) => Math.max(1, s - 2)); break;
      case ']': setSize((s) => Math.min(80, s + 2)); break;
    }
  };

  useEffect(() => {
    const h = (e: KeyboardEvent) => kbRef.current(e);
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, []);

  const getPoint = (e: ReactPointerEvent): StrokePoint => {
    const c = canvasRef.current!;
    const rect = c.getBoundingClientRect();
    const x = (e.clientX - rect.left) * (c.width / rect.width);
    const y = (e.clientY - rect.top) * (c.height / rect.height);
    const pressure = e.pointerType === 'mouse' ? 1 : e.pressure > 0 ? e.pressure : 0.5;
    return { x, y, pressure };
  };

  const ensureSnapshot = (): HTMLCanvasElement => {
    if (!snapshotRef.current) {
      const s = document.createElement('canvas');
      s.width = width;
      s.height = height;
      snapshotRef.current = s;
    }
    return snapshotRef.current;
  };

  const renderStrokePreview = (strokes: StrokePoint[]) => {
    const c = canvasRef.current!;
    const ctx = c.getContext('2d')!;
    ctx.drawImage(ensureSnapshot(), 0, 0);
    ctx.save();
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.lineWidth = size;
    if (tool === 'eraser') {
      ctx.globalCompositeOperation = 'destination-out';
      ctx.strokeStyle = `rgba(0,0,0,${opacity})`;
    } else {
      const [r, g, b] = hexToRgb(color);
      ctx.globalCompositeOperation = 'source-over';
      ctx.strokeStyle = `rgba(${r},${g},${b},${opacity})`;
    }
    ctx.beginPath();
    strokes.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
    if (strokes.length === 1) ctx.lineTo(strokes[0].x + 0.01, strokes[0].y);
    ctx.stroke();
    ctx.restore();
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

  const getActiveLayer = () => session.state.layers.find((l) => l.id === activeLayerId);

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

  const onPointerDown = (e: ReactPointerEvent) => {
    if (previewing) return;
    const c = canvasRef.current!;
    c.setPointerCapture?.(e.pointerId);
    const pt = getPoint(e);
    if (tool === 'eyedropper') {
      pickColor(pt.x, pt.y);
    } else if (tool === 'bucket') {
      doFill(pt.x, pt.y);
    } else if (tool === 'translate') {
      dragRef.current = { startX: pt.x, startY: pt.y };
    } else if (tool === 'select') {
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
      const snap = ensureSnapshot();
      const sctx = snap.getContext('2d')!;
      sctx.clearRect(0, 0, width, height);
      sctx.drawImage(c, 0, 0);
      renderStrokePreview(drawingRef.current.strokes);
    }
  };

  const onPointerMove = (e: ReactPointerEvent) => {
    if (showCursor) moveCursor(e.clientX, e.clientY);
    if (drawingRef.current) {
      drawingRef.current.strokes.push(getPoint(e));
      renderStrokePreview(drawingRef.current.strokes);
    } else if (dragRef.current) {
      const pt = getPoint(e);
      const dx = Math.round(pt.x - dragRef.current.startX);
      const dy = Math.round(pt.y - dragRef.current.startY);
      const preview: EditorState = {
        ...session.state,
        layers: session.state.layers.map((l) =>
          l.id === activeLayerId ? { ...l, offsetX: l.offsetX + dx, offsetY: l.offsetY + dy } : l,
        ),
      };
      compositeToCanvas(canvasRef.current!, preview);
    } else if (selectRef.current) {
      const pt = getPoint(e);
      drawSelectionPreview(selectRef.current.startX, selectRef.current.startY, pt.x, pt.y);
    } else if (shapeRef.current) {
      const pt = getPoint(e);
      renderStrokePreview(shapeStrokes(shapeRef.current.startX, shapeRef.current.startY, pt.x, pt.y));
    }
  };

  const onPointerUp = (e: ReactPointerEvent) => {
    if (drawingRef.current) {
      const strokes = drawingRef.current.strokes;
      drawingRef.current = null;
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
    } else if (dragRef.current) {
      const pt = getPoint(e);
      const dx = Math.round(pt.x - dragRef.current.startX);
      const dy = Math.round(pt.y - dragRef.current.startY);
      dragRef.current = null;
      if (dx !== 0 || dy !== 0) {
        const layer = getActiveLayer();
        let region;
        if (layer) {
          const before = layerContentBBox(layer);
          region =
            before.w > 0 && before.h > 0
              ? unionBBox(before, { x: before.x + dx, y: before.y + dy, w: before.w, h: before.h })
              : before;
        }
        session.apply(createTranslateOp(activeLayerId, dx, dy, width, height, region));
        onEdit();
      }
      repaint();
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

  const toggleVisibility = (l: Layer) => {
    if (previewing) return;
    session.apply(createSetLayerVisibilityOp(l.id, !l.visible, layerContentBBox(l)));
    onEdit();
    repaint();
  };

  const deleteLayer = (l: Layer) => {
    if (previewing || session.state.layers.length <= 1) return;
    session.apply(createRemoveLayerOp(l.id, layerContentBBox(l)));
    setActiveLayerId(session.state.activeLayerId);
    onEdit();
    repaint();
  };

  // dir=+1: 前面(上)へ / dir=-1: 背面(下)へ。layers[0] が最背面。
  const moveLayer = (l: Layer, dir: 1 | -1) => {
    if (previewing) return;
    const idx = session.state.layers.findIndex((x) => x.id === l.id);
    const to = idx + dir;
    if (to < 0 || to >= session.state.layers.length) return;
    session.apply(createReorderLayerOp(l.id, to, layerContentBBox(l)));
    onEdit();
    repaint();
  };

  const startRename = (l: Layer) => {
    setEditingLayerId(l.id);
    setEditingName(l.name);
  };

  const commitRename = (l: Layer) => {
    const name = editingName.trim();
    setEditingLayerId(null);
    if (name && name !== l.name) {
      session.apply(createRenameLayerOp(l.id, name));
      onEdit();
      repaint();
    }
  };

  const onOpacityInput = (l: Layer, v: number) => {
    setOpacityDraft({ id: l.id, v });
    opacityPreviewRef.current = { layerId: l.id, opacity: v };
    const c = canvasRef.current;
    if (c && !previewing) {
      compositeToCanvas(c, displayState());
      drawHighlight(c);
    }
  };

  const commitOpacity = (l: Layer) => {
    const pv = opacityPreviewRef.current;
    opacityPreviewRef.current = null;
    setOpacityDraft(null);
    if (pv && pv.layerId === l.id && Math.abs(pv.opacity - l.opacity) > 1e-6) {
      session.apply(createSetLayerOpacityOp(l.id, pv.opacity, layerContentBBox(l)));
      onEdit();
    }
    repaint();
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
      compositeToCanvas(canvasRef.current!, replayer.replay(log, k));
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
    const replayed = replayer.replay(session.getLog());
    const ok = statesEqual(replayed, session.state);
    setVerify({
      ok,
      msg: ok
        ? `OK — ${log.length} 操作の replay がライブ状態とビット一致`
        : 'NG — replay がライブ状態と不一致',
    });
  };

  return (
    <div className="editor">
      <div className="canvas-pane" ref={paneRef}>
        <canvas
          ref={canvasRef}
          className="edit-canvas"
          width={width}
          height={height}
          style={{ width, height, touchAction: 'none', cursor: showCursor ? 'none' : 'crosshair' }}
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
        <div
          ref={cursorRef}
          className="brush-cursor"
          style={{
            width: size,
            height: size,
            display: showCursor && hovering && !previewing ? 'block' : 'none',
            borderColor: tool === 'eraser' ? '#fff' : color,
          }}
        />
        {previewing && (
          <div className="preview-banner">
            履歴を閲覧中（読み取り専用）— step {histIndex}/{log.length}
            <button onClick={returnToLatest}>最新に戻る</button>
          </div>
        )}
        <div className="history">
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
      </div>

      <div className="panels">
        <section className="panel">
          <h2>Tools</h2>
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
          <label className="field">
            <span>color</span>
            <input type="color" value={color} onChange={(e) => setColor(e.target.value)} />
          </label>
          <label className="field">
            <span>size {size}</span>
            <input
              type="range"
              min={1}
              max={80}
              value={size}
              onChange={(e) => setSize(Number(e.target.value))}
            />
          </label>
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
          <p className="hint">
            ツール: B=Brush E=Eraser G=Fill I=Pick L=Line R=Rect V=Move S=Select／[ ]=サイズ／
            Ctrl+Z=Undo Ctrl+Shift+Z=Redo
          </p>
        </section>

        <section className="panel">
          <h2>Color adjust</h2>
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
        </section>

        <section className="panel">
          <h2>Layers</h2>
          <div className="tool-row">
            <button onClick={addLayer} disabled={previewing}>
              + Layer
            </button>
            <button onClick={() => imageInputRef.current?.click()} disabled={previewing}>
              Import image
            </button>
            <button onClick={exportPng} title="現在の合成を PNG 保存">
              Export PNG
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
          <ul className="layer-list">
            {session.state.layers
              .slice()
              .reverse()
              .map((l) => {
                const idx = session.state.layers.findIndex((x) => x.id === l.id);
                const isTop = idx === session.state.layers.length - 1;
                const isBottom = idx === 0;
                const editing = editingLayerId === l.id;
                const opVal = opacityDraft?.id === l.id ? opacityDraft.v : l.opacity;
                return (
                  <li key={l.id} className={`layer-item ${l.id === activeLayerId ? 'active' : ''}`}>
                    <div className="layer-head">
                      <button
                        className="icon-btn"
                        title={l.visible ? '表示中（クリックで非表示）' : '非表示（クリックで表示）'}
                        disabled={previewing}
                        onClick={() => toggleVisibility(l)}
                      >
                        {l.visible ? '👁' : '🚫'}
                      </button>
                      {editing ? (
                        <input
                          className="layer-name-input"
                          autoFocus
                          value={editingName}
                          onChange={(e) => setEditingName(e.target.value)}
                          onBlur={() => commitRename(l)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') commitRename(l);
                            else if (e.key === 'Escape') setEditingLayerId(null);
                          }}
                        />
                      ) : (
                        <span
                          className="layer-name"
                          onClick={() => setActiveLayerId(l.id)}
                          onDoubleClick={() => startRename(l)}
                          title="クリックで選択 / ダブルクリックで名称変更"
                        >
                          {l.name}
                          {(l.offsetX !== 0 || l.offsetY !== 0) && (
                            <span className="muted">
                              {' '}
                              @({l.offsetX},{l.offsetY})
                            </span>
                          )}
                        </span>
                      )}
                      <span className="layer-actions">
                        <button className="icon-btn" title="前面へ" disabled={previewing || isTop} onClick={() => moveLayer(l, 1)}>
                          ▲
                        </button>
                        <button className="icon-btn" title="背面へ" disabled={previewing || isBottom} onClick={() => moveLayer(l, -1)}>
                          ▼
                        </button>
                        <button className="icon-btn" title="名称変更" disabled={previewing} onClick={() => startRename(l)}>
                          ✎
                        </button>
                        <button
                          className="icon-btn"
                          title="削除"
                          disabled={previewing || session.state.layers.length <= 1}
                          onClick={() => deleteLayer(l)}
                        >
                          🗑
                        </button>
                      </span>
                    </div>
                    <div className="layer-opacity">
                      <input
                        type="range"
                        min={0}
                        max={1}
                        step={0.05}
                        value={opVal}
                        disabled={previewing}
                        onChange={(e) => onOpacityInput(l, Number(e.target.value))}
                        onPointerUp={() => commitOpacity(l)}
                        onBlur={() => commitOpacity(l)}
                        onKeyUp={() => commitOpacity(l)}
                      />
                      <span className="layer-opacity-val">{Math.round(opVal * 100)}%</span>
                    </div>
                  </li>
                );
              })}
          </ul>
        </section>

        <section className="panel log-panel">
          <h2>Operation log ({log.length})</h2>
          <p className="hint">各操作の ← は依存する親（root 直結＝並行 / #n＝直列）。</p>
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
        </section>
      </div>
    </div>
  );
}
