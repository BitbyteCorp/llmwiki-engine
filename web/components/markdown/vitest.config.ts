import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: { include: ['web/components/markdown/behavior.test.ts', 'web/components/workspace/layout.test.ts'] },
})
