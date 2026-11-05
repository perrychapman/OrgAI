/** $PAGER for diffs and long text, spawned with shell: false (cli-spec 5.2, W4-T2). Stub until W4-T2 lands. */
export function pagerCommand(env: NodeJS.ProcessEnv): { file: string; args: string[] } | null {
  void env
  throw new Error('not implemented (Wave 4)')
}

export async function showInPager(
  text: string,
  deps: {
    env: NodeJS.ProcessEnv
    suspend(): void
    resume(): void
    spawn?: typeof import('node:child_process').spawn
  }
): Promise<'shown' | 'no-pager'> {
  void [text, deps]
  throw new Error('not implemented (Wave 4)')
}
