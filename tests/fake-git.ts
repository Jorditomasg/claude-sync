import type { Command, FakeHost } from './fake-host'
import { fail, ok } from './fake-host'

export type Commit = { hash: string; message: string; tree: Map<string, string> }
export type Remote = { commits: Commit[]; created: boolean }

export const newRemote = (): Remote => ({ commits: [], created: false })

const REPO = '/home/u/.claude/plugins/data/config-sync-claude-sync/repo'

function tree (host: FakeHost): Map<string, string> {
  const out = new Map<string, string>()
  for (const [k, v] of host.files) if (k.startsWith(`${REPO}/`) && !k.startsWith(`${REPO}/.git`)) out.set(k.slice(REPO.length + 1), v)
  return out
}

function checkout (host: FakeHost, t: Map<string, string>) {
  for (const k of [...host.files.keys()]) if (k.startsWith(`${REPO}/`) && !k.startsWith(`${REPO}/.git`)) host.files.delete(k)
  for (const [k, v] of t) host.files.set(`${REPO}/${k}`, v)
}

const same = (a: Map<string, string>, b: Map<string, string>) => a.size === b.size && [...a].every(([k, v]) => b.get(k) === v)
const touches = (c: Commit, prev: Commit | undefined, prefix: string) => {
  const keys = new Set([...c.tree.keys(), ...(prev?.tree.keys() ?? [])])
  return [...keys].some(k => k.startsWith(prefix) && c.tree.get(k) !== prev?.tree.get(k))
}

export function gitCommand (remote: Remote, project?: { root: string; url?: string; tracked?: string[] }): Command {
  return (argv, options, host) => {
    if (argv[0] !== 'git') return undefined
    const [, cmd, ...rest] = argv
    if (cmd === '--version') return ok('git version 2.45\n')
    if (options.cwd !== REPO) {
      if (cmd === 'clone') {
        host.files.set(`${REPO}/.git/HEAD`, 'ref')
        checkout(host, remote.commits.at(-1)?.tree ?? new Map())
        return ok()
      }
      if (!project || !options.cwd?.startsWith(project.root)) return fail('not a git repository', 128)
      if (cmd === 'rev-parse') return ok(`${project.root}\n`)
      if (cmd === 'remote') return project.url ? ok(`${project.url}\n`) : fail('no remote', 2)
      if (cmd === 'ls-files') return ok((project.tracked ?? []).join('\n'))
      return fail('unexpected', 1)
    }
    const last = remote.commits.at(-1)
    const log = (prefix: string) => remote.commits.map((c, i) => ({ c, prev: remote.commits[i - 1] })).filter(({ c, prev }) => touches(c, prev, prefix)).map(({ c }) => c).reverse()
    switch (cmd) {
      case 'fetch': case 'add': case 'push': return ok()
      case 'config': return ok(rest.length === 1 ? 'me@example.com\n' : '')
      case 'rev-parse': return rest[0] === 'HEAD' ? ok(`${last?.hash ?? ''}\n`) : (last ? ok(last.hash) : fail('', 1))
      case 'reset': checkout(host, last?.tree ?? new Map()); return ok()
      case 'diff': return same(tree(host), last?.tree ?? new Map()) ? ok() : fail('', 1)
      case 'commit': remote.commits.push({ hash: `c${remote.commits.length + 1}`, message: options.stdin ?? '', tree: tree(host) }); return ok()
      case 'log': {
        const prefix = (rest[rest.length - 1] ?? '') + '/'
        const list = log(prefix)
        if (rest[0] === '-1') return ok(list[0] ? `${list[0].hash}\n` : '')
        return ok(list.map(c => `${c.hash}\t2026-10-30T12:00:00Z\t${c.message.split('\n')[0]}`).join('\n'))
      }
      case 'show': {
        const [hash, path] = (rest[0] ?? '').split(':')
        const text = remote.commits.find(c => c.hash === hash)?.tree.get(path ?? '')
        return text === undefined ? fail('missing', 128) : ok(text)
      }
      case 'ls-tree': {
        const hash = rest[2]
        const prefix = rest[4] ?? ''
        return ok([...(remote.commits.find(c => c.hash === hash)?.tree.keys() ?? [])].filter(k => k.startsWith(prefix)).join('\n'))
      }
    }
    return fail(`fake git: ${argv.join(' ')}`)
  }
}

export function ghCommand (remote: Remote, login = 'me'): Command {
  return argv => {
    if (argv[0] !== 'gh') return undefined
    const line = argv.slice(1).join(' ')
    if (line === '--version' || line.startsWith('auth status') || line.startsWith('auth setup-git')) return ok()
    if (line.startsWith('api user')) return ok(`${login}\n`)
    if (line.startsWith('repo view')) return remote.created ? ok() : fail('not found')
    if (line.startsWith('repo create')) { remote.created = true; return ok() }
    return fail(line)
  }
}

export function claudeCommand (opts: { failInstall?: string[]; version?: string } = {}): Command {
  return (argv, _options, host) => {
    if (argv[0] !== 'claude') return undefined
    const [, , sub, name] = argv
    const file = '/home/u/.claude/plugins/installed_plugins.json'
    if (sub === 'install') {
      if (opts.failInstall?.includes(name ?? '')) return fail('plugin not found in marketplace')
      const data = JSON.parse(host.files.get(file) ?? '{"version":2,"plugins":{}}')
      data.plugins[name ?? ''] = [{ scope: 'user', installPath: '/nowhere', version: opts.version ?? '1.2.0', gitCommitSha: 'abc123' }]
      host.files.set(file, JSON.stringify(data))
      return ok()
    }
    if (sub === 'uninstall') {
      const data = JSON.parse(host.files.get(file) ?? '{"plugins":{}}')
      delete data.plugins[name ?? '']
      host.files.set(file, JSON.stringify(data))
      return ok()
    }
    if (sub === 'marketplace' || sub === 'configure') return ok()
    return fail(argv.join(' '))
  }
}
