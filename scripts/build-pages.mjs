import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const basePath = process.env.VITE_BASE_PATH || '/graffiland/';
const apiBase =
  process.env.VITE_API_BASE || 'https://graffiland-api.maxinfeld-artshow.workers.dev';

execSync('npx vite build', {
  stdio: 'inherit',
  env: {
    ...process.env,
    VITE_BASE_PATH: basePath,
    VITE_API_BASE: apiBase
  }
});

// Guard against static replacement regressions (e.g. non-literal import.meta?.env skipping VITE_API_BASE)
const assetsDir = path.join(process.cwd(), 'dist', 'assets');
const entryFiles = fs
  .readdirSync(assetsDir)
  .filter((name) => /^index-.*\.js$/.test(name));
if (entryFiles.length === 0) {
  throw new Error('Pages build verification failed: no dist/assets/index-*.js entry bundle found.');
}
const combinedEntryCode = entryFiles
  .map((name) => fs.readFileSync(path.join(assetsDir, name), 'utf8'))
  .join('\n');
if (!combinedEntryCode.includes(apiBase) || combinedEntryCode.includes('.VITE_API_BASE')) {
  throw new Error(
    `Pages build verification failed: expected VITE_API_BASE (${apiBase}) to be statically inlined without leftover .VITE_API_BASE references.`
  );
}
