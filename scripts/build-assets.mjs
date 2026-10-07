import { cpSync, existsSync, mkdirSync } from 'node:fs';

for (const directory of ['db/migrations', 'knowledge/seed']) {
  const source = `src/${directory}`;
  if (existsSync(source)) {
    mkdirSync(`dist/${directory}`, { recursive: true });
    cpSync(source, `dist/${directory}`, { recursive: true });
  }
}
