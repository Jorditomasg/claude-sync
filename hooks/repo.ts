import type { Host, RunResult } from './host'
import { isFileKind, type Content } from './inventory'
import { join, type Env } from './platform'
import { emptyManifest, type Manifest, type ManifestItem } from './profile'

export const REPO_NAME = 'claude-sync-config'
export const repoDir = (env: Env) => join(env, env.dataDir, 'repo')

export type Tools = { git: boolean; gh: boolean; ghAuthed: boolean; login?: string }
export type Version = { commit: string; date: string; message: string }

export class GitError extends Error {}

export const git = (host: Host, env: Env, args: string[], stdin?: string) =>
  host.run(['git', ...args], { cwd: repoDir(env), timeoutMs: 300_000, stdin })

async function must (result: Promise<RunResult>, what: string): Promise<string> {
  const r = await result
  if (r.code !== 0) throw new GitError(`${what}: ${(r.stderr || r.stdout).trim()}`)
  return r.stdout
}

export async function checkTools (host: Host): Promise<Tools> {
  const gitOk = (await host.run(['git', '--version'])).code === 0
  const ghOk = (await host.run(['gh', '--version'])).code === 0
  if (!ghOk) return { git: gitOk, gh: false, ghAuthed: false }
  const authed = (await host.run(['gh', 'auth', 'status', '--hostname', 'github.com'])).code === 0
  if (!authed) return { git: gitOk, gh: true, ghAuthed: false }
  const user = await host.run(['gh', 'api', 'user', '--jq', '.login'])
  return { git: gitOk, gh: true, ghAuthed: true, login: user.code === 0 ? user.stdout.trim() : undefined }
}

const README = `# claude-sync-config

Private copy of a Claude Code setup, written by [claude-sync](https://github.com/Jorditomasg/claude-sync).

- \`profiles/<name>/manifest.json\` lists the items of each profile; their content sits beside it.
- Each commit is a version you can bring back from \`/sync\` → Version history.
- Secrets are never stored here: they appear as \`\${secret:<name>}\` and are asked on the machine that applies them.

Edit it through \`/sync\`, not by hand.
`

export async function ensureRepo (host: Host, env: Env, login: string): Promise<string> {
  const full = `${login}/${REPO_NAME}`
  await host.run(['gh', 'auth', 'setup-git', '--hostname', 'github.com'])
  if ((await host.run(['gh', 'repo', 'view', full, '--json', 'name'])).code !== 0) {
    await must(host.run(['gh', 'repo', 'create', REPO_NAME, '--private', '--description', 'My Claude Code setup, kept by claude-sync']), 'gh repo create')
  }
  const dir = repoDir(env)
  if (!(await host.exists(join(env, dir, '.git')))) {
    await host.remove(dir)
    await must(host.run(['git', 'clone', `https://github.com/${full}.git`, dir], { timeoutMs: 300_000 }), 'git clone')
  }
  if ((await git(host, env, ['config', 'user.email'])).stdout.trim() === '') {
    await git(host, env, ['config', 'user.name', login])
    await git(host, env, ['config', 'user.email', `${login}@users.noreply.github.com`])
  }
  if (!(await host.exists(join(env, dir, 'README.md')))) await host.write(join(env, dir, 'README.md'), README)
  return full
}

const hasRemoteMain = async (host: Host, env: Env) => (await git(host, env, ['rev-parse', '--verify', '-q', 'origin/main'])).code === 0

export async function fetch (host: Host, env: Env): Promise<void> {
  await must(git(host, env, ['fetch', '--prune', 'origin']), 'git fetch')
  if (await hasRemoteMain(host, env)) await must(git(host, env, ['reset', '--hard', 'origin/main']), 'git reset')
}

export async function profiles (host: Host, env: Env): Promise<string[]> {
  return (await host.list(join(env, repoDir(env), 'profiles'))).filter(e => e.kind === 'dir').map(e => e.name).sort()
}

export async function headOf (host: Host, env: Env, profile: string): Promise<string | undefined> {
  if (!(await hasRemoteMain(host, env))) return undefined
  const r = await git(host, env, ['log', '-1', '--format=%H', 'origin/main', '--', `profiles/${profile}`])
  return r.stdout.trim() || undefined
}

async function readAt (host: Host, env: Env, rel: string, commit?: string): Promise<string | undefined> {
  if (!commit) return host.read(join(env, repoDir(env), rel))
  const r = await git(host, env, ['show', `${commit}:${rel}`])
  return r.code === 0 ? r.stdout : undefined
}

async function filesAt (host: Host, env: Env, rel: string, commit?: string): Promise<string[]> {
  if (commit) {
    const r = await git(host, env, ['ls-tree', '-r', '--name-only', commit, '--', `${rel}/`])
    return r.stdout.split('\n').filter(Boolean).map(f => f.slice(rel.length + 1))
  }
  const walk = async (sub: string): Promise<string[]> => {
    const out: string[] = []
    for (const e of await host.list(join(env, repoDir(env), rel, sub))) {
      const path = sub ? `${sub}/${e.name}` : e.name
      if (e.kind === 'file') out.push(path)
      else if (e.kind === 'dir') out.push(...await walk(path))
    }
    return out
  }
  return walk('')
}

export async function readManifest (host: Host, env: Env, profile: string, commit?: string): Promise<Manifest> {
  const text = await readAt(host, env, `profiles/${profile}/manifest.json`, commit)
  return text ? (JSON.parse(text) as Manifest) : emptyManifest(profile)
}

export async function readContent (host: Host, env: Env, profile: string, item: ManifestItem, commit?: string): Promise<Content> {
  const rel = `profiles/${profile}/${item.path}`
  if (!isFileKind(item.kind)) return { value: JSON.parse((await readAt(host, env, rel, commit)) ?? 'null') }
  const files: Record<string, string> = {}
  for (const name of (await filesAt(host, env, rel, commit)).sort()) files[name] = (await readAt(host, env, `${rel}/${name}`, commit)) ?? ''
  return { files }
}

export async function writeContent (host: Host, env: Env, profile: string, item: Pick<ManifestItem, 'kind' | 'path'>, content: Content): Promise<string[]> {
  const rel = `profiles/${profile}/${item.path}`
  const abs = join(env, repoDir(env), rel)
  await host.remove(abs)
  if (!isFileKind(item.kind)) {
    await host.write(abs, JSON.stringify(content.value ?? null, null, 2) + '\n')
    return [abs]
  }
  const written: string[] = []
  for (const [name, text] of Object.entries(content.files ?? {})) {
    const path = join(env, abs, name)
    await host.write(path, text)
    written.push(path)
  }
  return written
}

export const removeContent = (host: Host, env: Env, profile: string, item: Pick<ManifestItem, 'path'>) =>
  host.remove(join(env, repoDir(env), `profiles/${profile}/${item.path}`))

export async function readExceptions (host: Host, env: Env): Promise<string[]> {
  const text = await host.read(join(env, repoDir(env), 'exceptions.json'))
  try { return text ? ((JSON.parse(text) as { hashes?: string[] }).hashes ?? []) : [] } catch { return [] }
}

export async function writeExceptions (host: Host, env: Env, hashes: readonly string[]): Promise<void> {
  await host.write(join(env, repoDir(env), 'exceptions.json'), JSON.stringify({ hashes: [...new Set(hashes)].sort() }, null, 2) + '\n')
}

export async function writeManifest (host: Host, env: Env, manifest: Manifest): Promise<void> {
  await host.write(join(env, repoDir(env), 'profiles', manifest.profile, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
}

export async function history (host: Host, env: Env, profile: string): Promise<Version[]> {
  if (!(await hasRemoteMain(host, env))) return []
  const r = await git(host, env, ['log', '--format=%H%x09%cI%x09%s', 'origin/main', '--', `profiles/${profile}`])
  return r.stdout.split('\n').filter(Boolean).map(line => {
    const [commit = '', date = '', ...message] = line.split('\t')
    return { commit, date, message: message.join('\t') }
  })
}

export async function commitAndPush (host: Host, env: Env, message: string): Promise<string> {
  await must(git(host, env, ['add', '-A', '--', '.']), 'git add')
  if ((await git(host, env, ['diff', '--cached', '--quiet'])).code !== 0) {
    await must(git(host, env, ['commit', '-q', '-F', '-'], message), 'git commit')
    await must(git(host, env, ['push', '-q', '-u', 'origin', 'HEAD:main']), 'git push')
    await git(host, env, ['fetch', '-q', 'origin'])
  }
  return (await must(git(host, env, ['rev-parse', 'HEAD']), 'git rev-parse')).trim()
}
