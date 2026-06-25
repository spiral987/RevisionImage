// すべての操作ハンドラをレジストリに登録する。
// このモジュールを import すると副作用として登録が走る（applyOperation の前提）。
import { registerOp } from '../operation';
import { brushHandler } from './brush';
import { eraserHandler } from './eraser';
import { translateHandler } from './translate';
import { brightnessHandler } from './brightness';
import { hueHandler } from './hue';
import { addLayerHandler } from './addLayer';
import { addImageLayerHandler } from './addImageLayer';
import {
  setLayerVisibilityHandler,
  setLayerOpacityHandler,
  renameLayerHandler,
  removeLayerHandler,
  reorderLayerHandler,
  clearLayerHandler,
  mergeDownLayerHandler,
  moveNodeHandler,
  addGroupHandler,
  setGroupCollapsedHandler,
} from './layerOps';
import { fillHandler } from './fill';
import { transformHandler } from './transform';
import { baselineHandler } from './baseline';

registerOp(brushHandler);
registerOp(eraserHandler);
registerOp(translateHandler);
registerOp(brightnessHandler);
registerOp(hueHandler);
registerOp(addLayerHandler);
registerOp(addImageLayerHandler);
registerOp(setLayerVisibilityHandler);
registerOp(setLayerOpacityHandler);
registerOp(renameLayerHandler);
registerOp(removeLayerHandler);
registerOp(reorderLayerHandler);
registerOp(clearLayerHandler);
registerOp(mergeDownLayerHandler);
registerOp(moveNodeHandler);
registerOp(addGroupHandler);
registerOp(setGroupCollapsedHandler);
registerOp(fillHandler);
registerOp(transformHandler);
registerOp(baselineHandler);

export { brushHandler, createBrushOp, type BrushParams } from './brush';
export { eraserHandler, createEraserOp, type EraserParams } from './eraser';
export { translateHandler, createTranslateOp, type TranslateParams } from './translate';
export { brightnessHandler, createBrightnessOp, type BrightnessParams } from './brightness';
export { hueHandler, createHueOp, type HueParams } from './hue';
export { addLayerHandler, createAddLayerOp, type AddLayerParams } from './addLayer';
export {
  addImageLayerHandler,
  createAddImageLayerOp,
  type AddImageLayerParams,
} from './addImageLayer';
export {
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
  type SetLayerVisibilityParams,
  type SetLayerOpacityParams,
  type RenameLayerParams,
  type RemoveLayerParams,
  type ReorderLayerParams,
  type ClearLayerParams,
  type MergeDownLayerParams,
  type MoveNodeParams,
  type AddGroupParams,
  type SetGroupCollapsedParams,
} from './layerOps';
export { fillHandler, createFillOp, fillRegion, type FillParams } from './fill';
export { transformHandler, createTransformOp, type TransformParams } from './transform';
export { baselineHandler, createBaselineOp, type BaselineParams } from './baseline';
