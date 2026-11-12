import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const rootDir = process.cwd();
const distDir = path.join(rootDir, 'dist');
const remoteUrl = execSync('git remote get-url origin', { encoding: 'utf8' }).trim();

execSync('node scripts/build-pages.mjs', { stdio: 'inherit' });

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'graffiland-pages-'));
try {
  fs.cpSync(distDir, tempDir, { recursive: true });
  // SPA fallback 404.html for GitHub Pages
  fs.copyFileSync(path.join(tempDir, 'index.html'), path.join(tempDir, '404.html'));
  fs.writeFileSync(path.join(tempDir, '.nojekyll'), '');

  const run = (cmd) => execSync(cmd, { cwd: tempDir, stdio: 'inherit' });
  run('git init');
  run('git checkout -b gh-pages');
  run('git config user.name "Max Infeld"');
  run('git config user.email "maxinfeld@gmail.com"');
  run('git add -A');
  run('git commit -m "Deploy GRAFFILAND to GitHub Pages"');
  run(`git push --force "${remoteUrl}" gh-pages`);
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}
