import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

if (existsSync('web/package.json')) {
  const result = spawnSync('pnpm', ['--dir', 'web', 'build'], { stdio: 'inherit' });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
}
