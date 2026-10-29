import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

export default defineConfig({
  resolve: { alias: { '@shared': fileURLToPath(new URL('./src/shared', import.meta.url)) } },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // Worktree tests shell out to git many times; Windows file systems are slow.
    testTimeout: 60_000,
    hookTimeout: 60_000
  }
})
