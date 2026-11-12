import { execSync } from 'node:child_process';

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
