/**
 * ORGAI_QUIET=1 (test plumbing, like the ORGAI_WINDOW_* flags): the app raises no OS notification, taskbar flash or Dock
 * bounce. Read once from the environment at process start in index.ts and passed to the notifier as a dep; there is no
 * setting, project file, IPC channel, socket call or agent tool that can turn it on. Everything before the OS call (what
 * would be shown, categories, the Inbox) is unchanged. Only the exact value '1' turns it on.
 */
export function parseQuiet(value: string | undefined): boolean {
  return value === '1'
}
