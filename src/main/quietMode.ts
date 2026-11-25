/**
 * ORGAI_QUIET=1 (test plumbing, like the ORGAI_WINDOW_* flags): the app raises no OS notification, taskbar flash or Dock
 * bounce. Read once from the environment at process start in index.ts and passed to the notifier as a dep; there is no
 * setting, project file, IPC channel, socket call or agent tool that can turn it on. Everything before the OS call (what
 * would be shown, categories, the Inbox) is unchanged. Only the exact value '1' turns it on, and only when ORGAI_DATA_DIR
 * is also set to a non-empty value (e2e and verify-pack always set it), so a stray persistent variable cannot silence a
 * real install.
 */
export function parseQuiet(value: string | undefined, dataDir?: string): boolean {
  return value === '1' && typeof dataDir === 'string' && dataDir !== ''
}
