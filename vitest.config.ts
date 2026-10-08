import { defineConfig } from 'vitest/config';
import swc from 'unplugin-swc';

export default defineConfig({
  plugins: [swc.vite({ tsconfigFile: './tsconfig.json' })],
  test: {
    include: ['src/**/*.test.ts', 'test/**/*.test.ts', 'web/components/workspace/**/*.test.ts'],
    setupFiles: ['reflect-metadata'],
  },
});
