import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { CID } from 'multiformats/cid';
import * as raw from 'multiformats/codecs/raw';
import { sha256 } from 'multiformats/hashes/sha2';
import { buildSculptureGlb } from '../../shared/glb.mjs';
import { buildIpfsMetadata } from '../../shared/sculpture.mjs';
import { CONFIG } from '../config.mjs';

async function computeRawCid(buffer) {
  const hash = await sha256.digest(buffer);
  const cid = CID.create(1, raw.code, hash);
  return cid.toString();
}

async function pinBufferToLocal(buffer, ext = '') {
  fs.mkdirSync(CONFIG.ipfsStorageDir, { recursive: true });
  const cid = await computeRawCid(buffer);
  const filePath = path.join(CONFIG.ipfsStorageDir, cid);
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, buffer);
  }
  if (ext) {
    fs.writeFileSync(`${filePath}.meta.json`, JSON.stringify({ ext, size: buffer.length }));
  }
  return {
    cid,
    uri: `ipfs://${cid}`,
    gatewayUrl: `/ipfs/${cid}`,
    provider: 'local-cid'
  };
}

async function pinFileToPinata(buffer, fileName, mimeType) {
  const form = new FormData();
  form.append('file', new Blob([buffer], { type: mimeType }), fileName);
  form.append('pinataMetadata', JSON.stringify({ name: fileName }));

  const res = await fetch('https://api.pinata.cloud/pinning/pinFileToIPFS', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${CONFIG.pinataJwt}`
    },
    body: form
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Pinata pinFile error: ${res.status} ${txt}`);
  }
  const data = await res.json();
  return {
    cid: data.IpfsHash,
    uri: `ipfs://${data.IpfsHash}`,
    gatewayUrl: `${CONFIG.ipfsGateway}/${data.IpfsHash}`,
    provider: 'pinata'
  };
}

async function pinJsonToPinata(obj, name) {
  const res = await fetch('https://api.pinata.cloud/pinning/pinJSONToIPFS', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${CONFIG.pinataJwt}`
    },
    body: JSON.stringify({
      pinataMetadata: { name },
      pinataContent: obj
    })
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Pinata pinJSON error: ${res.status} ${txt}`);
  }
  const data = await res.json();
  return {
    cid: data.IpfsHash,
    uri: `ipfs://${data.IpfsHash}`,
    gatewayUrl: `${CONFIG.ipfsGateway}/${data.IpfsHash}`,
    provider: 'pinata'
  };
}

async function pinBufferToKubo(buffer, fileName) {
  const form = new FormData();
  form.append('file', new Blob([buffer]), fileName);
  const res = await fetch(`${CONFIG.ipfsApiUrl.replace(/\/$/, '')}/api/v0/add?pin=true&cid-version=1`, {
    method: 'POST',
    body: form
  });
  if (!res.ok) {
    throw new Error(`Kubo IPFS add error: ${res.status}`);
  }
  const data = await res.json();
  return {
    cid: data.Hash,
    uri: `ipfs://${data.Hash}`,
    gatewayUrl: `${CONFIG.ipfsGateway}/${data.Hash}`,
    provider: 'kubo'
  };
}

function decodePreviewDataUrl(previewDataUrl) {
  if (typeof previewDataUrl === 'string' && previewDataUrl.startsWith('data:image/')) {
    const idx = previewDataUrl.indexOf(',');
    if (idx !== -1) {
      const header = previewDataUrl.slice(0, idx);
      const b64 = previewDataUrl.slice(idx + 1);
      const mime = header.match(/data:([^;]+)/)?.[1] || 'image/png';
      return { buffer: Buffer.from(b64, 'base64'), mime };
    }
  }
  // Minimal deterministic SVG fallback if no canvas snapshot provided
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512"><rect width="512" height="512" fill="#0d0f1a"/><text x="256" y="256" fill="#00f5d4" font-family="monospace" font-size="28" text-anchor="middle">GRAFFILAND 3D</text></svg>`;
  return { buffer: Buffer.from(svg, 'utf8'), mime: 'image/svg+xml' };
}

export async function pinSculptureToIpfs({
  sculptureId,
  title,
  description,
  voxels,
  previewDataUrl,
  locationBundle,
  creatorAddress,
  royaltyBps,
  royaltyReceiver
}) {
  const preview = decodePreviewDataUrl(previewDataUrl);
  const glbBytes = buildSculptureGlb(voxels, {
    id: sculptureId,
    title,
    parcelId: locationBundle.parcelId,
    geohash: locationBundle.geohash
  });
  const modelBuffer = Buffer.from(glbBytes);

  let imagePin;
  let modelPin;

  if (CONFIG.pinataJwt) {
    imagePin = await pinFileToPinata(
      preview.buffer,
      `${sculptureId}-preview.${preview.mime.includes('svg') ? 'svg' : 'png'}`,
      preview.mime
    );
    modelPin = await pinFileToPinata(modelBuffer, `${sculptureId}-model.glb`, 'model/gltf-binary');
  } else if (CONFIG.ipfsApiUrl) {
    imagePin = await pinBufferToKubo(preview.buffer, `${sculptureId}-preview.png`);
    modelPin = await pinBufferToKubo(modelBuffer, `${sculptureId}-model.glb`);
  } else {
    imagePin = await pinBufferToLocal(preview.buffer, preview.mime);
    modelPin = await pinBufferToLocal(modelBuffer, 'model/gltf-binary');
  }

  const metadata = buildIpfsMetadata({
    sculptureId,
    title,
    description,
    imageUri: imagePin.uri,
    modelUri: modelPin.uri,
    publicUrl: CONFIG.publicUrl,
    voxels,
    locationBundle,
    creatorAddress,
    royaltyBps,
    royaltyReceiver
  });

  let metadataPin;
  if (CONFIG.pinataJwt) {
    metadataPin = await pinJsonToPinata(metadata, `${sculptureId}-metadata.json`);
  } else if (CONFIG.ipfsApiUrl) {
    metadataPin = await pinBufferToKubo(
      Buffer.from(JSON.stringify(metadata, null, 2), 'utf8'),
      `${sculptureId}-metadata.json`
    );
  } else {
    metadataPin = await pinBufferToLocal(
      Buffer.from(JSON.stringify(metadata, null, 2), 'utf8'),
      'application/json'
    );
  }

  return {
    provider: metadataPin.provider,
    metadataCid: metadataPin.cid,
    metadataUri: metadataPin.uri,
    gatewayUrl: metadataPin.gatewayUrl,
    modelCid: modelPin.cid,
    modelUri: modelPin.uri,
    imageCid: imagePin.cid,
    imageUri: imagePin.uri,
    metadata
  };
}

export function readLocalIpfsCid(cid) {
  if (!/^[a-zA-Z0-9_-]{10,128}$/.test(cid)) return null;
  const filePath = path.join(CONFIG.ipfsStorageDir, cid);
  if (!fs.existsSync(filePath)) return null;
  const buffer = fs.readFileSync(filePath);
  let contentType = 'application/octet-stream';
  const metaPath = `${filePath}.meta.json`;
  if (fs.existsSync(metaPath)) {
    try {
      const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
      if (meta.ext) contentType = meta.ext;
    } catch {
      // ignore
    }
  }
  return { buffer, contentType };
}
