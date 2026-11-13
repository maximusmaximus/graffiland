import {
  AREA_HALF_SPAN_METERS,
  AREA_LIMIT_BLOCKS,
  POLICY,
  VOXEL_STEP
} from '../../shared/constants.mjs';

const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;

export function sanitizeVoxels(voxels) {
  const errors = [];
  if (!Array.isArray(voxels) || voxels.length < POLICY.minVoxels || voxels.length > POLICY.maxVoxels) {
    errors.push(`Sculpture must contain between ${POLICY.minVoxels} and ${POLICY.maxVoxels} 3D voxels.`);
  }

  const cleanVoxels = [];
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;

  if (Array.isArray(voxels)) {
    for (let i = 0; i < Math.min(voxels.length, POLICY.maxVoxels); i++) {
      const v = voxels[i];
      const x = Number(v?.x);
      const y = Number(v?.y);
      const z = Number(v?.z);
      const scale = Number(v?.scale ?? 1);
      const color = typeof v?.color === 'string' && HEX_COLOR_RE.test(v.color) ? v.color : '#ff3e7f';
      const material = v?.material === 'neon' || v?.material === 'glass' ? v.material : 'matte';

      if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
        errors.push(`Voxel #${i + 1} has invalid coordinates.`);
        break;
      }
      if (
        Math.abs(x) > AREA_HALF_SPAN_METERS ||
        Math.abs(y) > AREA_HALF_SPAN_METERS ||
        Math.abs(z) > AREA_HALF_SPAN_METERS
      ) {
        errors.push(
          `Voxel coordinates exceed ${AREA_LIMIT_BLOCKS}x${AREA_LIMIT_BLOCKS}x${AREA_LIMIT_BLOCKS} block area bounds.`
        );
        break;
      }
      const rx = Math.round(x * 1000) / 1000;
      const ry = Math.round(y * 1000) / 1000;
      const rz = Math.round(z * 1000) / 1000;
      if (rx < minX) minX = rx;
      if (ry < minY) minY = ry;
      if (rz < minZ) minZ = rz;
      if (rx > maxX) maxX = rx;
      if (ry > maxY) maxY = ry;
      if (rz > maxZ) maxZ = rz;

      cleanVoxels.push({
        x: rx,
        y: ry,
        z: rz,
        color,
        material,
        scale: Math.min(2, Math.max(0.25, Number.isFinite(scale) ? scale : 1))
      });
    }
  }

  if (cleanVoxels.length > 0) {
    const spanBlocksX = Math.round((maxX - minX) / VOXEL_STEP) + 1;
    const spanBlocksY = Math.round((maxY - minY) / VOXEL_STEP) + 1;
    const spanBlocksZ = Math.round((maxZ - minZ) / VOXEL_STEP) + 1;
    if (
      spanBlocksX > AREA_LIMIT_BLOCKS ||
      spanBlocksY > AREA_LIMIT_BLOCKS ||
      spanBlocksZ > AREA_LIMIT_BLOCKS
    ) {
      errors.push(
        `Sculpture dimensions exceed the ${AREA_LIMIT_BLOCKS}x${AREA_LIMIT_BLOCKS}x${AREA_LIMIT_BLOCKS} block area limit.`
      );
    }
  }

  return { errors, cleanVoxels };
}

export function validatePublishPayload(body) {
  const errors = [];
  const title = String(body?.title || '').trim();
  const description = String(body?.description || '').trim();

  if (title.length < POLICY.titleMin || title.length > POLICY.titleMax) {
    errors.push(`Title must be between ${POLICY.titleMin} and ${POLICY.titleMax} characters.`);
  }
  if (/[\r\n]/.test(title)) {
    errors.push('Title must be a single line.');
  }

  const words = description ? description.split(/\s+/).filter(Boolean) : [];
  if (description.length < POLICY.descriptionMin || description.length > POLICY.descriptionMax) {
    errors.push(`Description must be between ${POLICY.descriptionMin} and ${POLICY.descriptionMax} characters.`);
  }
  if (words.length > POLICY.descriptionMaxWords) {
    errors.push(`Description cannot exceed ${POLICY.descriptionMaxWords} words.`);
  }

  const combined = `${title} ${description}`.toLowerCase();
  for (const term of POLICY.prohibitedTerms) {
    if (combined.includes(term)) {
      errors.push(`Content violates the Limited Terms Policy (restricted phrase: "${term}").`);
      break;
    }
  }

  if (body?.termsAccepted !== true) {
    errors.push('You must accept the GRAFFILAND Terms of Service and Virtual Land Rules.');
  }

  const voxelValidation = sanitizeVoxels(body?.voxels);
  errors.push(...voxelValidation.errors);

  return {
    ok: errors.length === 0,
    errors,
    title,
    description,
    cleanVoxels: voxelValidation.cleanVoxels
  };
}
