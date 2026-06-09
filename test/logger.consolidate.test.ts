import { describe, it, expect } from 'vitest';
import '../src/engine/operations';
import { Logger } from '../src/backend/logger';
import {
  createBrushOp,
  createEraserOp,
  createTranslateOp,
  createBrightnessOp,
  createAddLayerOp,
} from '../src/engine/operations';
import { line } from './helpers';

const W = 64;
const H = 64;
const P = { color: [0, 0, 0] as [number, number, number], size: 6, opacity: 1 };

describe('Logger consolidation (SPEC §7 / 原論文 5.1)', () => {
  it('連続する同一パラメータのブラシは1操作に統合される', () => {
    const logger = new Logger();
    logger.append(createBrushOp('L', line(0, 0, 5, 5, 3), P, W, H));
    logger.append(createBrushOp('L', line(5, 5, 10, 10, 3), P, W, H));
    logger.append(createBrushOp('L', line(10, 10, 20, 20, 3), P, W, H));

    const log = logger.getLog();
    expect(log.length).toBe(1);
    expect(log[0].strokes?.length).toBe(9); // 3 + 3 + 3
  });

  it('パラメータ(色)が異なるブラシは統合されない', () => {
    const logger = new Logger();
    logger.append(createBrushOp('L', line(0, 0, 5, 5), P, W, H));
    logger.append(createBrushOp('L', line(0, 0, 5, 5), { ...P, color: [255, 0, 0] }, W, H));
    expect(logger.getLog().length).toBe(2);
  });

  it('レイヤが異なるブラシは統合されない', () => {
    const logger = new Logger();
    logger.append(createBrushOp('L1', line(0, 0, 5, 5), P, W, H));
    logger.append(createBrushOp('L2', line(0, 0, 5, 5), P, W, H));
    expect(logger.getLog().length).toBe(2);
  });

  it('消しゴムも連続で統合される', () => {
    const logger = new Logger();
    logger.append(createEraserOp('L', line(0, 0, 5, 5, 2), { size: 8, opacity: 1 }, W, H));
    logger.append(createEraserOp('L', line(5, 5, 9, 9, 2), { size: 8, opacity: 1 }, W, H));
    expect(logger.getLog().length).toBe(1);
    expect(logger.getLog()[0].strokes?.length).toBe(4);
  });

  it('translate は dx/dy が加算統合される', () => {
    const logger = new Logger();
    logger.append(createTranslateOp('L', 3, 4, W, H));
    logger.append(createTranslateOp('L', 5, -1, W, H));
    const log = logger.getLog();
    expect(log.length).toBe(1);
    expect(log[0].params).toMatchObject({ dx: 8, dy: 3 });
  });

  it('brightness は統合せず別エントリになる（clamp 非結合のため）', () => {
    const logger = new Logger();
    logger.append(createBrightnessOp('L', 10, W, H));
    logger.append(createBrightnessOp('L', 20, W, H));
    expect(logger.getLog().length).toBe(2);
  });

  it('種類が変わると統合は途切れる（addLayer を挟む）', () => {
    const logger = new Logger();
    logger.append(createBrushOp('L', line(0, 0, 5, 5), P, W, H));
    logger.append(createAddLayerOp('L2', 'Layer 1', W, H));
    logger.append(createBrushOp('L', line(5, 5, 9, 9), P, W, H));
    expect(logger.getLog().length).toBe(3);
  });
});
