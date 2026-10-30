import { canonical, sha256, type Json } from './hash'
import type { Host } from './host'
import { mergeInto, parseJson, type Edit } from './jsonmerge'
import { basename, contractHome, contractPath, encodeProjectPath, expandHome, join, mapStrings, normalizeRemote, osHints, type Env } from './platform'
import { maskTokens } from './secrets'

export type Kind =
  | 'claude-md' | 'hook' | 'script' | 'permission' | 'setting' | 'skill' | 'agent' | 'command' | 'keybindings'
  | 'marketplace' | 'plugin' | 'plugin-data' | 'mcp'
  | 'project-file' | 'project-skill' | 'project-agent' | 'project-command' | 'project-config' | 'memory'

export type Content = { files?: Record<string, string>; value?: Json }

export type Item = {
  id: string
  kind: Kind
  key: string
  label: string
  content: Content
  project?: string
  requires?: string[]
  hints?: string[]
  inProjectGit?: boolean
  sensitiveOptions?: string[]
}

export type Collected = { items: Item[]; warnings: string[]; project?: { id: string; root: string } }

export const SELF = 'config-sync'
export const SELF_MARKETPLACE = 'claude-sync'
const SETTINGS_OWN = new Set(['hooks', 'permissions', 'enabledPlugins', 'extraKnownMarketplaces', 'pluginConfigs'])
const PROJECT_CONFIG = ['allowedTools', 'mcpServers', 'enabledMcpjsonServers', 'disabledMcpjsonServers', 'mcpContextUris']
const PROJECT_FILES = ['CLAUDE.md', 'CLAUDE.local.md', '.mcp.json', '.claude/settings.json', '.claude/settings.local.json']
const EXECUTABLE = new Set<Kind>(['hook', 'script', 'setting', 'mcp'])

export const isProjectKind = (kind: Kind) => kind.startsWith('project-') || kind === 'memory'
export const isFileKind = (kind: Kind) => !['hook', 'permission', 'setting', 'marketplace', 'plugin', 'mcp', 'project-config'].includes(kind)

export const hashContent = (content: Content) => sha256(canonical(content))

const isHidden = (rel: string) => rel.split('/').some(part => part.startsWith('.'))
const isEmpty = (value: Json | undefined) =>
  value === undefined || value === null || value === '' || (typeof value === 'object' && Object.keys(value).length === 0)

async function readJson (host: Host, path: string, warnings: string[]): Promise<Record<string, Json>> {
  try {
    return parseJson(await host.read(path), path)
  } catch (error) {
    warnings.push((error as Error).message)
    return {}
  }
}

async function listFiles (host: Host, env: Env, dir: string, rel = ''): Promise<string[]> {
  const out: string[] = []
  for (const entry of await host.list(rel ? join(env, dir, rel) : dir)) {
    const path = rel ? `${rel}/${entry.name}` : entry.name
    if (entry.kind === 'file') out.push(path)
    else if (entry.kind === 'dir' && entry.name !== '.git' && entry.name !== 'node_modules') out.push(...await listFiles(host, env, dir, path))
  }
  return out.sort()
}

async function readFiles (host: Host, env: Env, dir: string, names: string[], contract: (t: string) => string): Promise<Record<string, string>> {
  const files: Record<string, string> = {}
  for (const name of names) {
    const text = await host.read(join(env, dir, name))
    if (text !== undefined) files[name] = contract(text)
  }
  return files
}

const short = (text: string, max = 60) => (text.length > max ? `${text.slice(0, max - 1)}…` : text)

export function fileBase (item: Pick<Item, 'kind' | 'key'>, env: Env, root?: string): string {
  const c = env.claudeDir
  const r = root ?? ''
  switch (item.kind) {
    case 'skill': return join(env, c, 'skills', item.key)
    case 'agent': return join(env, c, 'agents')
    case 'command': return join(env, c, 'commands')
    case 'plugin-data': return join(env, c, 'plugins')
    case 'project-file': return r
    case 'project-skill': return join(env, r, '.claude', 'skills', item.key)
    case 'project-agent': return join(env, r, '.claude', 'agents')
    case 'project-command': return join(env, r, '.claude', 'commands')
    case 'memory': return join(env, c, 'projects', encodeProjectPath(r), 'memory')
    default: return c
  }
}

function withHints (item: Item): Item {
  if (!EXECUTABLE.has(item.kind)) return item
  const hints = [...osHints(canonical(item.content))]
  return hints.length > 0 ? { ...item, hints } : item
}

function referencedScripts (command: string): string[] {
  return [...command.matchAll(/~\/\.claude\/([^\s"'`;|&)]+)/g)].map(m => m[1] ?? '').filter(Boolean)
}

export async function collectGlobal (host: Host, env: Env): Promise<Collected> {
  const warnings: string[] = []
  const items: Item[] = []
  const c = env.claudeDir
  const home = (t: string) => contractHome(t, env.home)
  const homeValue = (v: Json) => mapStrings(v, home)
  const settings = await readJson(host, join(env, c, 'settings.json'), warnings)
  const local = await readJson(host, join(env, c, 'settings.local.json'), warnings)

  const claudeMd = await host.read(join(env, c, 'CLAUDE.md'))
  if (claudeMd !== undefined) items.push({ id: 'claude-md', kind: 'claude-md', key: 'CLAUDE.md', label: 'CLAUDE.md', content: { files: { 'CLAUDE.md': home(claudeMd) } } })

  const scripts = new Set((await listFiles(host, env, join(env, c, 'hooks'))).map(f => `hooks/${f}`))
  const hooks = (settings.hooks ?? {}) as Record<string, { matcher?: string; hooks?: Json[] }[]>
  for (const [event, groups] of Object.entries(hooks)) {
    for (const group of Array.isArray(groups) ? groups : []) {
      for (const raw of group.hooks ?? []) {
        const hook = homeValue(raw)
        const command = String((hook as { command?: string }).command ?? '')
        const id = `hook:${event}:${group.matcher ?? ''}:${(await sha256(maskTokens(canonical(hook)))).slice(0, 8)}`
        const requires = referencedScripts(command)
        for (const s of requires) scripts.add(s)
        const value: Json = group.matcher === undefined ? { event, hook } : { event, matcher: group.matcher, hook }
        items.push({ id, kind: 'hook', key: id.slice(5), label: `${event}${group.matcher ? ` ${group.matcher}` : ''} · ${short(maskTokens(command))}`, content: { value }, requires: requires.map(s => `script:${s}`) })
      }
    }
  }

  const permissions = (settings.permissions ?? {}) as Record<string, Json>
  for (const [key, value] of Object.entries(permissions)) {
    if (['allow', 'deny', 'ask'].includes(key) && Array.isArray(value)) {
      for (const rule of value) {
        const text = home(String(rule))
        const safe = maskTokens(text)
        items.push({ id: `permission:${key}:${safe}`, kind: 'permission', key: `${key}:${safe}`, label: `${key} ${safe}`, content: { value: text } })
      }
    } else items.push({ id: `permission:${key}`, kind: 'permission', key, label: key, content: { value: homeValue(value) } })
  }

  for (const [key, value] of Object.entries(settings)) {
    if (SETTINGS_OWN.has(key)) continue
    const item: Item = { id: `setting:${key}`, kind: 'setting', key, label: key, content: { value: homeValue(value) } }
    if (key === 'statusLine') {
      const requires = referencedScripts(String((item.content.value as { command?: string })?.command ?? ''))
      for (const s of requires) scripts.add(s)
      if (requires.length > 0) item.requires = requires.map(s => `script:${s}`)
    }
    items.push(item)
  }

  for (const rel of [...scripts].sort()) {
    const text = await host.read(join(env, c, rel))
    if (text !== undefined) items.push({ id: `script:${rel}`, kind: 'script', key: rel, label: rel, content: { files: { [rel]: home(text) } } })
  }

  for (const entry of await host.list(join(env, c, 'skills'))) {
    if (entry.kind !== 'dir' || entry.name === 'synced' || isHidden(entry.name)) continue
    const dir = join(env, c, 'skills', entry.name)
    items.push({ id: `skill:${entry.name}`, kind: 'skill', key: entry.name, label: entry.name, content: { files: await readFiles(host, env, dir, await listFiles(host, env, dir), home) } })
  }
  for (const name of (await listFiles(host, env, join(env, c, 'agents'))).filter(f => f.endsWith('.md') && !isHidden(f))) {
    items.push({ id: `agent:${name}`, kind: 'agent', key: name, label: name.replace(/\.md$/, ''), content: { files: await readFiles(host, env, join(env, c, 'agents'), [name], home) } })
  }
  for (const name of (await listFiles(host, env, join(env, c, 'commands'))).filter(f => f.endsWith('.md') && !isHidden(f))) {
    items.push({ id: `command:${name}`, kind: 'command', key: name, label: `/${name.replace(/\.md$/, '').replace(/\//g, ':')}`, content: { files: await readFiles(host, env, join(env, c, 'commands'), [name], home) } })
  }
  const keys = await host.read(join(env, c, 'keybindings.json'))
  if (keys !== undefined) items.push({ id: 'keybindings', kind: 'keybindings', key: 'keybindings.json', label: 'keybindings.json', content: { files: { 'keybindings.json': keys } } })

  const known = await readJson(host, join(env, c, 'plugins', 'known_marketplaces.json'), warnings)
  const extra = (settings.extraKnownMarketplaces ?? {}) as Record<string, { source?: Json }>
  for (const name of [...new Set([...Object.keys(known), ...Object.keys(extra)])].sort()) {
    if (name === SELF_MARKETPLACE) continue
    const source = (known[name] as { source?: Json } | undefined)?.source ?? extra[name]?.source
    if (source !== undefined) items.push({ id: `marketplace:${name}`, kind: 'marketplace', key: name, label: name, content: { value: { source: homeValue(source) } } })
  }

  const installed = (await readJson(host, join(env, c, 'plugins', 'installed_plugins.json'), warnings)).plugins as Record<string, { scope?: string; installPath?: string; version?: string; gitCommitSha?: string }[]> | undefined
  const enabled = { ...(local.enabledPlugins as Record<string, boolean> | undefined), ...(settings.enabledPlugins as Record<string, boolean> | undefined) }
  const configs = (settings.pluginConfigs ?? {}) as Record<string, Json>
  const store = await host.list(join(env, c, 'plugins', 'store'))
  for (const [pluginId, records] of Object.entries(installed ?? {})) {
    const record = (records ?? []).find(r => r.scope === 'user') ?? records?.[0]
    const [name = pluginId, market = ''] = pluginId.split('@')
    if (!record || name === SELF) continue
    const manifest = record.installPath ? await readJson(host, join(env, record.installPath, '.claude-plugin', 'plugin.json'), []) : {}
    const userConfig = (manifest.userConfig ?? {}) as Record<string, { sensitive?: boolean }>
    const sensitiveOptions = Object.entries(userConfig).filter(([, o]) => o?.sensitive === true).map(([k]) => k)
    const value: Record<string, Json> = { enabled: enabled[pluginId] === true }
    if (record.version) value.version = record.version
    if (record.gitCommitSha) value.gitCommitSha = record.gitCommitSha
    if (configs[pluginId] !== undefined) value.config = homeValue(configs[pluginId] as Json)
    items.push({ id: `plugin:${pluginId}`, kind: 'plugin', key: pluginId, label: pluginId, content: { value }, requires: market ? [`marketplace:${market}`] : [], ...(sensitiveOptions.length ? { sensitiveOptions } : {}) })

    const dataDir = `data/${name}-${market}`
    const data = (await listFiles(host, env, join(env, c, 'plugins', dataDir))).map(f => `${dataDir}/${f}`)
    const stored = store.filter(e => e.kind === 'file' && e.name.startsWith(`${name}_${market}-`)).map(e => `store/${e.name}`)
    if (data.length + stored.length > 0) {
      items.push({ id: `plugin-data:${pluginId}`, kind: 'plugin-data', key: pluginId, label: pluginId, content: { files: await readFiles(host, env, join(env, c, 'plugins'), [...data, ...stored], t => t) }, requires: [`plugin:${pluginId}`] })
    }
  }

  const claudeJson = await readJson(host, env.claudeJson, warnings)
  for (const [name, server] of Object.entries((claudeJson.mcpServers ?? {}) as Record<string, Json>)) {
    items.push({ id: `mcp:${name}`, kind: 'mcp', key: name, label: name, content: { value: homeValue(server) } })
  }
  return { items: items.map(withHints), warnings }
}

export async function projectIdentity (host: Host, root: string): Promise<string> {
  const remote = await host.run(['git', 'remote', 'get-url', 'origin'], { cwd: root })
  return remote.code === 0 && remote.stdout.trim() ? normalizeRemote(remote.stdout.trim()) : basename(root)
}

export function projectEntryKey (projects: Record<string, Json>, root: string): string {
  const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
  return Object.keys(projects).find(k => k === root) ?? Object.keys(projects).find(k => norm(k) === norm(root)) ?? root.replace(/\\/g, '/')
}

export async function collectProject (host: Host, env: Env, root: string, id?: string): Promise<Collected> {
  const warnings: string[] = []
  const items: Item[] = []
  const pid = id ?? await projectIdentity(host, root)
  const text = (t: string) => contractHome(contractPath(t, root, '.'), env.home)
  const p = (kind: Kind, key: string, label: string, content: Content): Item => ({ id: `p:${pid}:${kind.replace('project-', '')}:${key}`, kind, key, label, content, project: pid })

  for (const rel of PROJECT_FILES) {
    const body = await host.read(join(env, root, rel))
    if (body !== undefined) items.push(p('project-file', rel, rel, { files: { [rel]: text(body) } }))
  }
  const dot = join(env, root, '.claude')
  for (const entry of await host.list(join(env, dot, 'skills'))) {
    if (entry.kind !== 'dir' || isHidden(entry.name)) continue
    const dir = join(env, dot, 'skills', entry.name)
    items.push(p('project-skill', entry.name, entry.name, { files: await readFiles(host, env, dir, await listFiles(host, env, dir), text) }))
  }
  for (const name of (await listFiles(host, env, join(env, dot, 'agents'))).filter(f => f.endsWith('.md') && !isHidden(f))) {
    items.push(p('project-agent', name, name.replace(/\.md$/, ''), { files: await readFiles(host, env, join(env, dot, 'agents'), [name], text) }))
  }
  for (const name of (await listFiles(host, env, join(env, dot, 'commands'))).filter(f => f.endsWith('.md') && !isHidden(f))) {
    items.push(p('project-command', name, `/${name.replace(/\.md$/, '')}`, { files: await readFiles(host, env, join(env, dot, 'commands'), [name], text) }))
  }

  const claudeJson = await readJson(host, env.claudeJson, warnings)
  const projects = (claudeJson.projects ?? {}) as Record<string, Json>
  const entry = projects[projectEntryKey(projects, root)] as Record<string, Json> | undefined
  for (const key of PROJECT_CONFIG) {
    if (entry && !isEmpty(entry[key])) items.push(p('project-config', key, key, { value: mapStrings(entry[key] as Json, text) }))
  }

  const memory = join(env, env.claudeDir, 'projects', encodeProjectPath(root), 'memory')
  for (const name of (await listFiles(host, env, memory)).filter(f => !isHidden(f))) {
    items.push(p('memory', name, name, { files: await readFiles(host, env, memory, [name], text) }))
  }

  const tracked = await host.run(['git', 'ls-files'], { cwd: root })
  if (tracked.code === 0) {
    const set = new Set(tracked.stdout.split('\n').map(l => l.trim()).filter(Boolean))
    for (const item of items) {
      if (item.kind === 'memory' || item.kind === 'project-config') continue
      const base = item.kind === 'project-file' ? '' : item.kind === 'project-skill' ? `.claude/skills/${item.key}/` : item.kind === 'project-agent' ? '.claude/agents/' : '.claude/commands/'
      if (Object.keys(item.content.files ?? {}).some(f => set.has(base + f))) item.inProjectGit = true
    }
  }
  return { items: items.map(withHints), warnings, project: { id: pid, root } }
}

export type Target = { root?: string }
export type JsonWrite = { file: string; edits: Edit[] }
export type FileWrite = { path: string; text?: string }

const jsonFor = (env: Env, file: 'settings' | 'claudeJson') => (file === 'settings' ? join(env, env.claudeDir, 'settings.json') : env.claudeJson)

export function valueEdits (item: Item, value: Json | undefined, env: Env, target: Target, projects: Record<string, Json> = {}): JsonWrite {
  const remove = value === undefined
  const v = value === undefined ? undefined : mapStrings(value, t => (EXECUTABLE.has(item.kind) || item.kind === 'plugin' || item.kind === 'marketplace' ? expandHome(t, env) : t))
  const settings = jsonFor(env, 'settings')
  switch (item.kind) {
    case 'hook': {
      const entry = (v ?? item.content.value) as { event: string; matcher?: string; hook: Json }
      return { file: settings, edits: [{ hook: entry, remove }] }
    }
    case 'permission': {
      const [list, ...rest] = item.key.split(':')
      if (['allow', 'deny', 'ask'].includes(list ?? '') && rest.length > 0) return { file: settings, edits: [{ list: ['permissions', list ?? ''], entry: (v ?? item.content.value) as Json, remove }] }
      return { file: settings, edits: [{ path: ['permissions', item.key], value: v, remove }] }
    }
    case 'setting': return { file: settings, edits: [{ path: [item.key], value: v, remove }] }
    case 'marketplace': return { file: settings, edits: [{ path: ['extraKnownMarketplaces', item.key], value: v, remove }] }
    case 'plugin': {
      const plugin = v as { enabled?: boolean; config?: Json } | undefined
      return {
        file: settings,
        edits: [
          { path: ['enabledPlugins', item.key], value: plugin === undefined ? undefined : plugin.enabled === true, remove },
          { path: ['pluginConfigs', item.key], value: plugin?.config, remove: remove || plugin?.config === undefined }
        ]
      }
    }
    case 'mcp': return { file: env.claudeJson, edits: [{ path: ['mcpServers', item.key], value: v, remove }] }
    case 'project-config': return { file: env.claudeJson, edits: [{ path: ['projects', projectEntryKey(projects, target.root ?? ''), item.key], value: v, remove }] }
    default: throw new Error(`not a value item: ${item.kind}`)
  }
}

export function fileWrites (item: Item, files: Record<string, string> | undefined, env: Env, target: Target): FileWrite[] {
  const base = fileBase(item, env, target.root)
  const expand = EXECUTABLE.has(item.kind) ? (t: string) => expandHome(t, env) : (t: string) => t
  return Object.entries(files ?? item.content.files ?? {}).map(([rel, text]) => ({ path: join(env, base, rel), text: files === undefined ? undefined : expand(text) }))
}

export async function applyJson (host: Host, write: JsonWrite): Promise<void> {
  await host.write(write.file, mergeInto(await host.read(write.file), write.edits, write.file))
}
