import type { EnvName, Host, RunOptions, RunResult } from '../hooks/host'

export type Command = (argv: string[], options: RunOptions, host: FakeHost) => RunResult | undefined
export type FakeHost = Host & { files: Map<string, string>; ran: { argv: string[]; options: RunOptions }[] }

export const ok = (stdout = ''): RunResult => ({ code: 0, stdout, stderr: '' })
export const fail = (stderr = 'failed', code = 1): RunResult => ({ code, stdout: '', stderr })

export function fakeHost (init: { env?: Partial<Record<EnvName, string>>; files?: Record<string, string>; commands?: Command[] } = {}): FakeHost {
  const files = new Map(Object.entries(init.files ?? {}))
  const ran: FakeHost['ran'] = []
  const norm = (p: string) => p.replace(/[\\/]+$/, '')
  const under = (p: string) => norm(p) + (p.includes('\\') ? '\\' : '/')
  const host: FakeHost = {
    files,
    ran,
    read: async p => files.get(p),
    write: async (p, text) => { files.set(p, text) },
    async list (p) {
      const prefix = under(p)
      const seen = new Map<string, 'file' | 'dir'>()
      for (const key of files.keys()) {
        if (!key.startsWith(prefix)) continue
        const rest = key.slice(prefix.length)
        const cut = rest.search(/[\\/]/)
        seen.set(cut < 0 ? rest : rest.slice(0, cut), cut < 0 ? 'file' : 'dir')
      }
      return [...seen].map(([name, kind]) => ({ name, kind }))
    },
    exists: async p => files.has(norm(p)) || [...files.keys()].some(k => k.startsWith(under(p))),
    async remove (p) {
      files.delete(norm(p))
      for (const key of [...files.keys()]) if (key.startsWith(under(p))) files.delete(key)
    },
    async run (argv, options = {}) {
      ran.push({ argv, options })
      for (const command of init.commands ?? []) {
        const result = command(argv, options, host)
        if (result) return result
      }
      return fail(`not found: ${argv[0]}`, 127)
    },
    env: async name => init.env?.[name],
    now: () => Date.parse('2026-10-30T12:00:00Z')
  }
  return host
}

export const POSIX = { HOME: '/home/u' } as const
export const unameLinux: Command = argv => (argv[0] === 'uname' ? ok(argv[1] === '-s' ? 'Linux\n' : '6.1.0\n') : undefined)
