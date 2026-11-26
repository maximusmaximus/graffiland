#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DATA_URL_IMAGE_RE = /^data:(image\/(?:png|jpeg|jpg|webp|gif|svg\+xml));base64,([A-Za-z0-9+/=\s]+)$/i;
const MIME_TO_EXT = new Map([
  ['image/png', 'png'],
  ['image/jpeg', 'jpg'],
  ['image/webp', 'webp'],
  ['image/gif', 'gif'],
  ['image/svg+xml', 'svg']
]);

function parseArgs(argv) {
  const args = {
    d1Name: 'graffiland-db',
    r2Bucket: 'graffiland-media',
    origin: 'https://graffiland-api.maxinfeld-artshow.workers.dev',
    wranglerConfig: path.resolve('worker/wrangler.toml'),
    dryRun: false
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--dry-run') args.dryRun = true;
    else if (a === '--origin' && argv[i + 1]) args.origin = String(argv[++i]).replace(/\/+$/, '');
    else if (a === '--r2-bucket' && argv[i + 1]) args.r2Bucket = String(argv[++i]);
    else if (a === '--d1-name' && argv[i + 1]) args.d1Name = String(argv[++i]);
  }
  return args;
}

function runWrangler(wranglerArgs) {
  const cmd = process.platform === 'win32' ? 'npx.cmd' : 'npx';
  return execFileSync(cmd, ['wrangler', ...wranglerArgs], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    shell: process.platform === 'win32'
  });
}

function d1Query(sql, args) {
  const raw = runWrangler([
    'd1',
    'execute',
    args.d1Name,
    '--remote',
    '--config',
    args.wranglerConfig,
    '--json',
    '--command',
    sql
  ]);
  const parsed = JSON.parse(raw);
  return Array.isArray(parsed) && parsed[0]?.results ? parsed[0].results : [];
}

function d1ExecFile(sqlFilePath, args) {
  return runWrangler([
    'd1',
    'execute',
    args.d1Name,
    '--remote',
    '--config',
    args.wranglerConfig,
    '--file',
    sqlFilePath,
    '--yes'
  ]);
}

function r2PutFile(r2Key, filePath, contentType, args) {
  runWrangler([
    'r2',
    'object',
    'put',
    `${args.r2Bucket}/${r2Key}`,
    '--remote',
    '--file',
    filePath,
    '--content-type',
    contentType,
    '--cache-control',
    'public, max-age=31536000, immutable'
  ]);
}

function sanitizeId(raw) {
  return String(raw || 'item')
    .trim()
    .replace(/[^a-zA-Z0-9_-]/g, '_')
    .replace(/_+/g, '_')
    .slice(0, 80);
}

function sqlEscape(val) {
  return String(val ?? '').replace(/'/g, "''");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'graffiland-r2-backfill-'));
  const sqlUpdates = [];
  let previewsMoved = 0;
  let modelsMoved = 0;
  let bytesFreed = 0;

  try {
    // 1. Migrate inline sculpture preview_data_url rows (one ID at a time to stay well below D1 response limits)
    const previewIds = d1Query(
      "SELECT id, LENGTH(preview_data_url) AS len FROM sculptures WHERE preview_data_url LIKE 'data:image/%' ORDER BY created_at ASC;",
      args
    );
    console.log(`[r2-backfill] Found ${previewIds.length} sculptures with inline preview data URLs.`);

    for (const item of previewIds) {
      const rows = d1Query(
        `SELECT id, preview_data_url FROM sculptures WHERE id = '${sqlEscape(item.id)}';`,
        args
      );
      const raw = String(rows[0]?.preview_data_url || '').trim();
      const m = raw.match(DATA_URL_IMAGE_RE);
      if (!m) continue;
      const mime = m[1].toLowerCase() === 'image/jpg' ? 'image/jpeg' : m[1].toLowerCase();
      const ext = MIME_TO_EXT.get(mime);
      if (!ext) continue;
      const bytes = Buffer.from(m[2].replace(/\s+/g, ''), 'base64');
      const hash = crypto.createHash('sha256').update(bytes).digest('hex').slice(0, 12);
      const key = `previews/sc-${sanitizeId(item.id)}-${hash}.${ext}`;
      const mediaUrl = `${args.origin}/api/media/${key}`;

      if (!args.dryRun) {
        const tmpFile = path.join(tmpDir, `${sanitizeId(item.id)}.${ext}`);
        fs.writeFileSync(tmpFile, bytes);
        r2PutFile(key, tmpFile, mime, args);
        sqlUpdates.push(
          `UPDATE sculptures SET preview_data_url = '${sqlEscape(mediaUrl)}' WHERE id = '${sqlEscape(item.id)}';`
        );
      }
      previewsMoved += 1;
      bytesFreed += Math.max(0, raw.length - mediaUrl.length);
      console.log(
        `  [${previewsMoved}/${previewIds.length}] ${item.id}: ${(raw.length / 1024).toFixed(1)} KB -> ${mediaUrl}`
      );
    }

    // 2. Migrate inline sculpture_models.inline_b64 rows to R2 models/<cid>
    const modelIds = d1Query(
      'SELECT sculpture_id, model_cid, mime_type, LENGTH(inline_b64) AS len FROM sculpture_models WHERE inline_b64 IS NOT NULL AND LENGTH(inline_b64) > 0;',
      args
    );
    console.log(`[r2-backfill] Found ${modelIds.length} sculpture_models with inline_b64 payloads.`);

    for (const item of modelIds) {
      const rows = d1Query(
        `SELECT sculpture_id, model_cid, mime_type, inline_b64 FROM sculpture_models WHERE sculpture_id = '${sqlEscape(item.sculpture_id)}';`,
        args
      );
      const b64 = String(rows[0]?.inline_b64 || '').trim();
      if (!b64) continue;
      const cid = String(rows[0]?.model_cid || '').trim() || `scmodel-${item.sculpture_id}`;
      const mime = String(rows[0]?.mime_type || 'model/gltf-binary').trim();
      const bytes = Buffer.from(b64, 'base64');
      const key = `models/${cid}`;

      if (!args.dryRun) {
        const tmpFile = path.join(tmpDir, `model-${sanitizeId(item.sculpture_id)}.bin`);
        fs.writeFileSync(tmpFile, bytes);
        r2PutFile(key, tmpFile, mime, args);
        sqlUpdates.push(
          `UPDATE sculpture_models SET inline_b64 = '', model_cid = '${sqlEscape(cid)}' WHERE sculpture_id = '${sqlEscape(item.sculpture_id)}';`
        );
      }
      modelsMoved += 1;
      bytesFreed += b64.length;
      console.log(
        `  [model ${modelsMoved}/${modelIds.length}] ${item.sculpture_id}: ${(b64.length / 1024).toFixed(1)} KB -> r2://${args.r2Bucket}/${key}`
      );
    }

    if (!args.dryRun && sqlUpdates.length > 0) {
      const sqlFile = path.join(tmpDir, 'backfill-updates.sql');
      fs.writeFileSync(sqlFile, `${sqlUpdates.join('\n')}\n`, 'utf8');
      console.log(`[r2-backfill] Applying ${sqlUpdates.length} D1 pointer updates...`);
      d1ExecFile(sqlFile, args);
    }

    console.log(
      `[r2-backfill] Complete (${args.dryRun ? 'DRY RUN' : 'APPLIED'}): previews=${previewsMoved}, models=${modelsMoved}, D1 bytes freed=${(bytesFreed / (1024 * 1024)).toFixed(2)} MB`
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error('[r2-backfill] Failed:', err?.message || err);
  process.exit(1);
});
