import { POLICY } from '../../shared/constants.mjs';

const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;

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

  const voxels = body?.voxels;
  if (!Array.isArray(voxels) || voxels.length < POLICY.minVoxels || voxels.length > POLICY.maxVoxels) {
    errors.push(`Sculpture must contain between ${POLICY.minVoxels} and ${POLICY.maxVoxels} 3D voxels.`);
  }

  const cleanVoxels = [];
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
      if (Math.abs(x) > 32 || Math.abs(y) > 32 || Math.abs(z) > 32) {
        errors.push('Voxel coordinates exceed sculpture bounds.');
        break;
      }
      cleanVoxels.push({
        x: Math.round(x * 1000) / 1000,
        y: Math.round(y * 1000) / 1000,
        z: Math.round(z * 1000) / 1000,
        color,
        material,
        scale: Math.min(2, Math.max(0.25, Number.isFinite(scale) ? scale : 1))
      });
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    title,
    description,
    cleanVoxels
  };
}
