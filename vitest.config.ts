import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

export default defineConfig({
  resolve: { alias: { '@shared': fileURLToPath(new URL('./src/shared', import.meta.url)) } },
  // vitest 3.2 runs on its own vite 7 (esbuild transforms): .tsx (the CLI TUI) uses React's automatic runtime.
  esbuild: { jsx: 'automatic', jsxImportSource: 'react' },
  test: {
    environment: 'node',
    // No unit test may write an OS key item (keychain, DPAPI, Secret Service): custodians/index.ts refuses the OS
    // schemes while this is set. Key-file and fake custodians are unaffected.
    env: { ORGAI_VAULT_NO_OS_KEYSTORE: '1', ORGAI_CLI_VAULT_NO_OS_KEYSTORE: '1' },
    include: ['src/**/*.test.{ts,tsx}'],
    // Worktree tests shell out to git many times; Windows file systems are slow.
    testTimeout: 60_000,
    hookTimeout: 60_000
  }
})
