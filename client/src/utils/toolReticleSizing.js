import { VOXEL_STEP } from '../../../shared/constants.mjs';
import { BLOCK_SIZE_PRESETS, normalizeBlockScale } from '../../../shared/voxelStroke.mjs';

const DEG2RAD = Math.PI / 180;

/**
 * Computes the screen-space circle diameter (px) representing the active Brush or Pencil
 * tool and selected block size at the active drawing depth / locked surface distance.
 *
 * - Pencil (`pencil`): 1.0x crisp voxel footprint diameter.
 * - Brush (`brush`): 1.28x spray-can nozzle footprint diameter with inner block core.
 * - Strictly monotonic across S (0.5x) < M (1.0x) < L (1.5x) < XL (2.0x) at every reach.
 */
export function computeCenterToolReticleMetrics({
  tool = 'brush',
  blockSize = 1,
  depthMeters = 1.8,
  vFovDeg = 65,
  viewportHeightPx = 844
} = {}) {
  const isSizedTool = tool === 'brush' || tool === 'pencil';
  const blockScale = normalizeBlockScale(blockSize);
  const preset =
    BLOCK_SIZE_PRESETS.find((p) => Math.abs(p.scale - blockScale) < 0.05) || BLOCK_SIZE_PRESETS[1];

  const worldBlockMeters = VOXEL_STEP * blockScale;
  const toolFactor = tool === 'brush' ? 1.28 : 1.0;
  const worldDiameterMeters = worldBlockMeters * toolFactor;

  const safeDepth = Math.max(0.45, Math.min(6, Number(depthMeters) || 1.8));
  const safeFov = Math.max(32, Math.min(82, Number(vFovDeg) || 65));
  const safeVpH = Math.max(320, Number(viewportHeightPx) || 844);

  const visibleWorldHeight = 2 * safeDepth * Math.tan((safeFov * 0.5) * DEG2RAD);
  const rawBlockPx = (worldBlockMeters / Math.max(0.1, visibleWorldHeight)) * safeVpH;

  // Keep S < M < L < XL cleanly distinguishable & readable even at farther reach distances
  const minReadableBlockPx = 24 + (blockScale - 0.5) * 26;
  const blockDiameterPx = Math.round(
    Math.max(22, Math.min(140, Math.max(rawBlockPx, minReadableBlockPx)))
  );
  const diameterPx = Math.round(Math.max(24, Math.min(176, blockDiameterPx * toolFactor)));
  const hitDiameterPx = Math.max(52, diameterPx + 14);

  return {
    isSizedTool,
    tool,
    blockScale,
    sizePresetLabel: preset.label,
    worldBlockMeters: Number(worldBlockMeters.toFixed(4)),
    worldDiameterMeters: Number(worldDiameterMeters.toFixed(4)),
    blockDiameterPx,
    diameterPx,
    hitDiameterPx
  };
}
