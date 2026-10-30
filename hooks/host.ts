import type { EngineInterface } from 'claude-code'

export type Entry = { name: string; kind: 'file' | 'dir' | 'other' }
export type RunOptions = { cwd?: string; stdin?: string; timeoutMs?: number }
export type RunResult = { code: number; stdout: string; stderr: string }

export type EnvName = 'HOME' | 'USERPROFILE' | 'OS' | 'WSL_DISTRO_NAME' | 'CLAUDE_CONFIG_DIR' | 'LANG' | 'LC_ALL' | 'LC_MESSAGES'

export interface Host {
  read (path: string): Promise<string | undefined>
  write (path: string, text: string): Promise<void>
  list (path: string): Promise<Entry[]>
  exists (path: string): Promise<boolean>
  remove (path: string): Promise<void>
  run (argv: string[], options?: RunOptions): Promise<RunResult>
  env (name: EnvName): Promise<string | undefined>
  now (): number
}

export function engineHost ($: EngineInterface): Host {
  const run = async (argv: string[], options: RunOptions = {}): Promise<RunResult> => {
    try {
      const r = await $.process.run(argv, { timeoutMs: 120_000, ...options })
      return { code: r.exitCode, stdout: r.stdout, stderr: r.stderr }
    } catch (error) {
      return { code: 127, stdout: '', stderr: String(error) }
    }
  }
  const env = (name: EnvName) => {
    switch (name) {
      case 'HOME': return $.env.get('HOME')
      case 'USERPROFILE': return $.env.get('USERPROFILE')
      case 'OS': return $.env.get('OS')
      case 'WSL_DISTRO_NAME': return $.env.get('WSL_DISTRO_NAME')
      case 'CLAUDE_CONFIG_DIR': return $.env.get('CLAUDE_CONFIG_DIR')
      case 'LANG': return $.env.get('LANG')
      case 'LC_ALL': return $.env.get('LC_ALL')
      case 'LC_MESSAGES': return $.env.get('LC_MESSAGES')
    }
  }
  return {
    read: path => $.fs.read(path).then(text => text, () => undefined),
    write: (path, text) => $.fs.write(path, text),
    list: path => $.fs.list(path).then(entries => entries.map(e => ({ name: e.name, kind: e.kind })), () => []),
    exists: path => $.fs.exists(path).catch(() => false),
    async remove (path) {
      if (!(await $.fs.exists(path).catch(() => false))) return
      const posix = await run(['rm', '-rf', path])
      if (posix.code === 0) return
      const isDir = (await $.fs.stat(path)).kind === 'dir'
      await run(isDir ? ['cmd', '/c', 'rmdir', '/s', '/q', path] : ['cmd', '/c', 'del', '/f', '/q', path])
    },
    run,
    env,
    now: () => Date.now()
  }
}
