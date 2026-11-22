import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
import { PLYLoader } from 'three/examples/jsm/loaders/PLYLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';

let sharedDracoLoader = null;
function getSharedDracoLoader() {
  if (!sharedDracoLoader) {
    sharedDracoLoader = new DRACOLoader();
    const baseUrl = import.meta.env.BASE_URL || '/';
    sharedDracoLoader.setDecoderPath(`${baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`}draco/gltf/`);
    sharedDracoLoader.preload();
  }
  return sharedDracoLoader;
}

const TEXTURE_SLOTS = [
  'map',
  'normalMap',
  'roughnessMap',
  'metalnessMap',
  'emissiveMap',
  'aoMap',
  'bumpMap',
  'specularMap',
  'alphaMap'
];

/**
 * Ensures every texture & geometry on a loaded 3D model uses smooth linear + anisotropic
 * filtering and valid vertex normals so models never appear pixelated on maps, previews, or AR.
 */
export function enforceCrispTexturesAndShading(root, maxAnisotropy = 8) {
  if (!root || typeof root.traverse !== 'function') return root;
  const aniso = Math.max(1, Math.min(16, Number(maxAnisotropy) || 8));

  root.traverse((obj) => {
    if (!obj?.isMesh) return;
    if (obj.geometry && !obj.geometry.attributes?.normal && typeof obj.geometry.computeVertexNormals === 'function') {
      obj.geometry.computeVertexNormals();
    }
    const mats = Array.isArray(obj.material) ? obj.material : obj.material ? [obj.material] : [];
    for (const mat of mats) {
      if (!mat) continue;
      for (const slot of TEXTURE_SLOTS) {
        const tex = mat[slot];
        if (!tex) continue;
        tex.magFilter = THREE.LinearFilter;
        tex.minFilter =
          tex.generateMipmaps === false ? THREE.LinearFilter : THREE.LinearMipmapLinearFilter;
        tex.anisotropy = Math.max(tex.anisotropy || 1, aniso);
        tex.needsUpdate = true;
      }
      mat.needsUpdate = true;
    }
  });
  return root;
}

function normalizeLoadedObject(
  root,
  customModel = {},
  { maxAnisotropy = 8, applyCustomScale = true } = {}
) {
  const wrapper = new THREE.Group();
  wrapper.add(root);

  const initialBox = new THREE.Box3().setFromObject(wrapper);
  const size = new THREE.Vector3();
  const center = new THREE.Vector3();
  initialBox.getSize(size);
  initialBox.getCenter(center);

  const maxDim = Math.max(size.x, size.y, size.z, 0.001);
  // Fit overly tiny or huge external 3D assets cleanly into ~1.4m showcase scale before custom scale
  let autoFit = 1;
  if (maxDim > 3.2 || maxDim < 0.28) {
    autoFit = 1.4 / maxDim;
  }
  const baseSize = {
    width: Math.max(0.05, Math.round(size.x * autoFit * 10000) / 10000),
    height: Math.max(0.05, Math.round(size.y * autoFit * 10000) / 10000),
    depth: Math.max(0.05, Math.round(size.z * autoFit * 10000) / 10000)
  };
  const userScale =
    applyCustomScale && Number.isFinite(Number(customModel?.scale)) && Number(customModel.scale) > 0
      ? Number(customModel.scale)
      : 1;
  const finalScale = autoFit * userScale;

  root.scale.multiplyScalar(finalScale);
  root.position.set(
    -center.x * finalScale,
    -initialBox.min.y * finalScale,
    -center.z * finalScale
  );

  if (Number.isFinite(Number(customModel?.rotationY)) && Number(customModel.rotationY) !== 0) {
    wrapper.rotation.y = Number(customModel.rotationY);
  }

  wrapper.traverse((obj) => {
    if (obj.isMesh) {
      obj.castShadow = true;
      obj.receiveShadow = true;
    }
  });

  enforceCrispTexturesAndShading(wrapper, maxAnisotropy);

  const bounds = new THREE.Box3().setFromObject(wrapper);
  return { object3d: wrapper, bounds, baseSize };
}

export async function loadCustomModelObject(
  sculpture,
  resolveUrlFn = (u) => u,
  { maxAnisotropy = 8, applyCustomScale = true } = {}
) {
  const cm = sculpture?.customModel;
  if (!cm?.format) return null;

  const rawUrl = cm.downloadUrl || sculpture.modelGlbUrl;
  const url = resolveUrlFn(rawUrl);
  const format = String(cm.format || '').toLowerCase();

  let root;
  if (format === 'glb' || format === 'gltf') {
    const loader = new GLTFLoader();
    loader.setDRACOLoader(getSharedDracoLoader());
    loader.setMeshoptDecoder(MeshoptDecoder);
    const gltf = await loader.loadAsync(url);
    root = gltf.scene || (gltf.scenes && gltf.scenes[0]) || new THREE.Group();
  } else if (format === 'obj') {
    const loader = new OBJLoader();
    root = await loader.loadAsync(url);
    root.traverse((obj) => {
      if (obj.isMesh && !obj.material) {
        obj.material = new THREE.MeshStandardMaterial({
          color: 0x00f5d4,
          roughness: 0.32,
          metalness: 0.25
        });
      }
    });
  } else if (format === 'stl') {
    const loader = new STLLoader();
    const geo = await loader.loadAsync(url);
    geo.computeVertexNormals();
    const mat = new THREE.MeshStandardMaterial({
      color: 0x70f8ff,
      roughness: 0.28,
      metalness: 0.35
    });
    root = new THREE.Mesh(geo, mat);
  } else if (format === 'ply') {
    const loader = new PLYLoader();
    const geo = await loader.loadAsync(url);
    geo.computeVertexNormals();
    const mat = new THREE.MeshStandardMaterial({
      color: geo.attributes?.color ? 0xffffff : 0xffd166,
      vertexColors: Boolean(geo.attributes?.color),
      roughness: 0.34,
      metalness: 0.22
    });
    root = new THREE.Mesh(geo, mat);
  } else {
    throw new Error(`Unsupported 3D model format: ${format}`);
  }

  const normalized = normalizeLoadedObject(root, cm, { maxAnisotropy, applyCustomScale });
  normalized.object3d.traverse((obj) => {
    if (obj.isMesh) {
      obj.userData.sculpture = sculpture;
    }
  });
  return normalized;
}
