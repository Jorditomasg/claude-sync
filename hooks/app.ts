import { itemDiff, type ItemDiff } from './diff'
import type { Json } from './hash'
import type { Host } from './host'
import {
  applyJson, collectGlobal, collectProject, fileBase, fileWrites, hashContent, isFileKind, projectIdentity, valueEdits,
  type Content, type Item, type JsonWrite
} from './inventory'
import { deletePath, getPath, InvalidJson, parseJson, setPath, type Edit } from './jsonmerge'
import { join, type Env } from './platform'
import {
  importRows, mix, pendingCount, planImport, planUpload, storagePath, uploadRows, withRequired,
  type Manifest, type ProfileState, type Row, type SyncState
} from './profile'
import * as repo from './repo'
import { fillMarkers, findTokens, sanitizeValue, scanFiles, type Finding } from './secrets'

export type Ctx = { host: Host; env: Env; cwd: string; state: SyncState; save: (state: SyncState) => Promise<void> }
export type Summary = { applied: string[]; skipped: { id: string; reason: string }[]; warnings: string[]; restart: boolean }
export type Chip = { isReady: boolean; profile?: string; pending: number; incoming: boolean }

type Clean = { content: Content; hash: string; secrets: string[]; raw: string[] }
type Local = { items: Item[]; byId: Map<string, Item>; clean: Map<string, Clean>; hashes: Record<string, string>; warnings: string[]; project?: { id: string; root: string } }

export class SecretLeak extends Error {}

const profileState = (state: SyncState, profile: string): ProfileState => state.profiles[profile] ?? { synced: {} }

export async function projectRoot (host: Host, env: Env, cwd: string): Promise<string | undefined> {
  const top = await host.run(['git', 'rev-parse', '--show-toplevel'], { cwd })
  const root = top.code === 0 && top.stdout.trim() ? top.stdout.trim() : cwd
  const same = (a: string, b: string) => a.replace(/[\\/]+$/, '').toLowerCase() === b.replace(/[\\/]+$/, '').toLowerCase()
  if (same(root, env.home) || same(root, env.claudeDir)) return undefined
  return env.sep === '\\' ? root.replace(/\//g, '\\') : root
}

async function clean (item: Item): Promise<Clean> {
  if (item.content.files) return { content: item.content, hash: await hashContent(item.content), secrets: [], raw: [] }
  const { value, secrets, raw } = sanitizeValue(item.content.value ?? null, item.id)
  const content = { value }
  return { content, hash: await hashContent(content), secrets, raw }
}

export async function collectLocal (ctx: Ctx, root?: string, projectId?: string): Promise<Local> {
  const global = await collectGlobal(ctx.host, ctx.env)
  const where = root ?? await projectRoot(ctx.host, ctx.env, ctx.cwd)
  const project = where ? await collectProject(ctx.host, ctx.env, where, projectId) : undefined
  const items = [...global.items, ...(project?.items ?? [])]
  const cleaned = new Map<string, Clean>()
  const hashes: Record<string, string> = {}
  for (const item of items) {
    const c = await clean(item)
    cleaned.set(item.id, c)
    hashes[item.id] = c.hash
  }
  return { items, byId: new Map(items.map(i => [i.id, i])), clean: cleaned, hashes, warnings: [...global.warnings, ...(project?.warnings ?? [])], project: project?.project }
}

async function exceptions (ctx: Ctx): Promise<Set<string>> {
  return new Set([...ctx.state.exceptions, ...await repo.readExceptions(ctx.host, ctx.env)])
}

export async function status (ctx: Ctx, fetch = true): Promise<Chip> {
  const profile = ctx.state.profile
  if (!ctx.state.repo || !profile) return { isReady: false, pending: 0, incoming: false }
  if (fetch) await repo.fetch(ctx.host, ctx.env).catch(() => undefined)
  const manifest = await repo.readManifest(ctx.host, ctx.env, profile)
  const local = await collectLocal(ctx)
  const ps = profileState(ctx.state, profile)
  const pending = pendingCount(uploadRows(local.items, local.hashes, manifest, ps, ctx.env.os), ps)
  const head = await repo.headOf(ctx.host, ctx.env, profile)
  const incoming = (head !== undefined && head !== ps.commit) ||
    importRows(manifest, local.items, local.hashes, ps, ctx.env.os).some(r => r.status === 'remote-changed')
  return { isReady: true, profile, pending, incoming }
}

export type UploadPrep = { profile: string; rows: Row[]; findings: Finding[]; warnings: string[] }

export async function prepareUpload (ctx: Ctx, profile: string, checkAll = false): Promise<UploadPrep> {
  await repo.fetch(ctx.host, ctx.env)
  const manifest = await repo.readManifest(ctx.host, ctx.env, profile)
  const local = await collectLocal(ctx)
  const known = await exceptions(ctx)
  const findings: Finding[] = []
  for (const item of local.items) if (item.content.files) findings.push(...await scanFiles(item.id, item.content.files, known))
  const blocked = new Set(findings.map(f => f.itemId))
  const rows = uploadRows(local.items, local.hashes, manifest, profileState(ctx.state, profile), ctx.env.os).map(r => {
    if (blocked.has(r.id)) return { ...r, status: 'secret' as const, checked: false }
    if (checkAll && r.status === 'not-in-profile' && r.kind !== 'plugin-data') return { ...r, checked: true }
    return r
  })
  return { profile, rows, findings, warnings: local.warnings }
}

function assertClean (texts: readonly string[], raw: ReadonlySet<string>, allowed: ReadonlySet<string>): void {
  for (const text of texts) {
    for (const secret of raw) if (secret.length >= 4 && !allowed.has(secret) && text.includes(secret)) throw new SecretLeak('a secret value would be uploaded')
    for (const token of findTokens(text)) if (!allowed.has(token.text)) throw new SecretLeak('a token would be uploaded')
  }
}

export async function upload (ctx: Ctx, profile: string, selected: ReadonlySet<string>, answers: Record<string, 'remove' | 'keep'> = {}, newExceptions: readonly string[] = []): Promise<Summary> {
  const { host, env } = ctx
  await repo.fetch(host, env)
  const manifest = await repo.readManifest(host, env, profile)
  const local = await collectLocal(ctx)
  const ps = profileState(ctx.state, profile)
  const known = new Set([...await exceptions(ctx), ...newExceptions])
  const rows = uploadRows(local.items, local.hashes, manifest, ps, env.os)
  const plan = planUpload(rows, withRequired(rows, selected))
  const summary: Summary = { applied: [], skipped: [], warnings: local.warnings, restart: false }
  const written: string[] = []
  const raw = new Set<string>()
  const allowed = new Set<string>()
  for (const c of local.clean.values()) for (const r of c.raw) raw.add(r)
  const synced = { ...ps.synced }

  for (const id of plan.put) {
    const item = local.byId.get(id)
    const c = local.clean.get(id)
    if (!item || !c) continue
    if (item.content.files) {
      const findings = await scanFiles(id, item.content.files, known)
      if (findings.length > 0) { summary.skipped.push({ id, reason: 'secret' }); continue }
      for (const text of Object.values(item.content.files)) for (const t of findTokens(text)) allowed.add(t.text)
    }
    const path = storagePath(item)
    for (const file of await repo.writeContent(host, env, profile, { kind: item.kind, path }, c.content)) written.push((await host.read(file)) ?? '')
    manifest.items[id] = {
      kind: item.kind, key: item.key, label: item.label, hash: c.hash, os: env.os, updatedAt: new Date(host.now()).toISOString(), path,
      ...(item.project ? { project: item.project } : {}),
      ...(c.secrets.length ? { secrets: c.secrets } : {}),
      ...(item.sensitiveOptions ? { sensitiveOptions: item.sensitiveOptions } : {}),
      ...(item.requires?.length ? { requires: item.requires } : {}),
      ...(item.hints ? { hints: item.hints } : {}),
      ...(item.inProjectGit ? { inProjectGit: true } : {})
    }
    synced[id] = c.hash
    summary.applied.push(id)
  }
  for (const id of plan.askRemove) {
    const m = manifest.items[id]
    if (!m || answers[id] !== 'remove') continue
    await repo.removeContent(host, env, profile, m)
    delete manifest.items[id]
    delete synced[id]
    summary.applied.push(id)
  }
  for (const r of rows) if (r.status === 'same') synced[r.id] = local.hashes[r.id] ?? ''

  const allExceptions = [...known]
  await repo.writeExceptions(host, env, allExceptions)
  await repo.writeManifest(host, env, manifest)
  const message = `${profile}: ${summary.applied.length} item(s)\n\n${summary.applied.map(id => `- ${manifest.items[id]?.label ?? id}`).join('\n')}\n`
  assertClean([...written, JSON.stringify(manifest), message], raw, allowed)
  const commit = await repo.commitAndPush(host, env, message)
  await ctx.save({ ...ctx.state, profile, exceptions: allExceptions, profiles: { ...ctx.state.profiles, [profile]: { commit, synced } } })
  return summary
}

export type ImportPrep = { profile: string; commit?: string; manifest: Manifest; rows: Row[]; projects: string[]; sourceProject?: string; targetRoot?: string }

export async function prepareImport (ctx: Ctx, profile: string, commit?: string, sourceProject?: string, targetRoot?: string): Promise<ImportPrep> {
  await repo.fetch(ctx.host, ctx.env)
  const full = await repo.readManifest(ctx.host, ctx.env, profile, commit)
  const projects = [...new Set(Object.values(full.items).map(m => m.project).filter((p): p is string => p !== undefined))]
  const root = targetRoot ?? await projectRoot(ctx.host, ctx.env, ctx.cwd)
  const here = root ? await projectIdentity(ctx.host, root) : undefined
  const source = sourceProject ?? (here && projects.includes(here) ? here : projects[0])
  const manifest = { ...full, items: Object.fromEntries(Object.entries(full.items).filter(([, m]) => m.project === undefined || (root !== undefined && m.project === source))) }
  const local = await collectLocal(ctx, root, source)
  const rows = importRows(manifest, local.items, local.hashes, profileState(ctx.state, profile), ctx.env.os)
  return { profile, commit, manifest, rows, projects, sourceProject: source, targetRoot: root }
}

export async function diffFor (ctx: Ctx, prep: ImportPrep, id: string): Promise<ItemDiff> {
  const m = prep.manifest.items[id]
  const local = await collectLocal(ctx, prep.targetRoot, prep.sourceProject)
  const remote = m ? await repo.readContent(ctx.host, ctx.env, prep.profile, m, prep.commit) : undefined
  return itemDiff(local.clean.get(id)?.content, remote)
}

export type Asked = { name: string; label: string }

export async function deletionCandidates (ctx: Ctx, prep: ImportPrep, selected: ReadonlySet<string>): Promise<{ id: string; label: string }[]> {
  const local = await collectLocal(ctx, prep.targetRoot, prep.sourceProject)
  const rows = importRows(prep.manifest, local.items, local.hashes, profileState(ctx.state, prep.profile), ctx.env.os)
  return planImport(rows, withRequired(rows, selected), local.items, prep.sourceProject).askDelete.map(id => ({ id, label: local.byId.get(id)?.label ?? id }))
}

export async function missingSecrets (ctx: Ctx, prep: ImportPrep, selected: ReadonlySet<string>): Promise<Asked[]> {
  const local = await collectLocal(ctx, prep.targetRoot, prep.sourceProject)
  const asked: Asked[] = []
  for (const id of selected) {
    const m = prep.manifest.items[id]
    if (!m) continue
    if (m.secrets?.length) {
      const content = await repo.readContent(ctx.host, ctx.env, prep.profile, m, prep.commit)
      const { missing } = fillMarkers(content.value ?? null, id, local.byId.get(id)?.content.value, {})
      for (const name of missing) asked.push({ name, label: `${m.label} · ${name.slice(id.length + 1)}` })
    }
    for (const option of m.sensitiveOptions ?? []) asked.push({ name: `${id}#option:${option}`, label: `${m.label} · ${option}` })
  }
  return asked
}

type Backup = { createdAt: string; files: Record<string, string | null>; json: Record<string, { path: string[]; value?: Json }[]>; installed: string[] }
const backupPath = (env: Env) => join(env, env.dataDir, 'backup.json')

export async function hasBackup (ctx: Ctx): Promise<boolean> {
  return ctx.host.exists(backupPath(ctx.env))
}

async function snapshot (host: Host, env: Env, paths: Iterable<string>, dirs: Iterable<string>): Promise<Backup['files']> {
  const files: Backup['files'] = {}
  const walk = async (dir: string) => {
    for (const e of await host.list(dir)) {
      const p = join(env, dir, e.name)
      if (e.kind === 'file') files[p] = (await host.read(p)) ?? null
      else if (e.kind === 'dir') await walk(p)
    }
  }
  for (const dir of dirs) await walk(dir)
  for (const p of paths) if (!(p in files)) files[p] = (await host.read(p)) ?? null
  return files
}

async function restore (host: Host, backup: Pick<Backup, 'files' | 'json'>): Promise<void> {
  for (const [path, text] of Object.entries(backup.files)) {
    if (text === null) await host.remove(path)
    else await host.write(path, text)
  }
  for (const [file, entries] of Object.entries(backup.json)) {
    const root = parseJson(await host.read(file), file)
    for (const e of entries) {
      if (e.value === undefined) deletePath(root, e.path)
      else setPath(root, e.path, e.value)
    }
    await host.write(file, JSON.stringify(root, null, 2) + '\n')
  }
}

const editedPath = (edit: Edit): string[] => ('hook' in edit ? ['hooks', edit.hook.event] : 'list' in edit ? edit.list : edit.path)

const DIR_KINDS = new Set(['skill', 'project-skill'])
const ORDER = ['marketplace', 'plugin']
const RESTART = new Set(['marketplace', 'plugin', 'mcp', 'project-config', 'hook', 'setting', 'permission'])

function marketplaceArg (source: Json | undefined): string | undefined {
  const s = (source ?? {}) as { source?: string; repo?: string; url?: string; path?: string }
  return s.repo ?? s.url ?? s.path
}

export type ImportChoices = {
  selected: ReadonlySet<string>
  conflicts?: Record<string, 'remote' | 'local'>
  deletes?: Record<string, 'delete' | 'keep'>
  values?: Record<string, string>
}

export async function importItems (ctx: Ctx, prep: ImportPrep, choices: ImportChoices): Promise<Summary> {
  const { host, env } = ctx
  const root = prep.targetRoot
  const local = await collectLocal(ctx, root, prep.sourceProject)
  const rows = importRows(prep.manifest, local.items, local.hashes, profileState(ctx.state, prep.profile), env.os)
  const wanted = withRequired(rows, choices.selected)
  const keepLocal = Object.entries(choices.conflicts ?? {}).filter(([, v]) => v === 'local').map(([k]) => k)
  for (const id of keepLocal) wanted.delete(id)
  for (const r of rows) if (r.status === 'conflict' && choices.conflicts?.[r.id] !== 'remote') wanted.delete(r.id)
  const plan = planImport(rows, wanted, local.items, prep.sourceProject)
  const summary: Summary = { applied: [], skipped: [], warnings: [], restart: false }
  const target = { root }
  const values = choices.values ?? {}

  const fetched = new Map<string, Content>()
  for (const id of plan.put) {
    const m = prep.manifest.items[id]
    if (m) fetched.set(id, await repo.readContent(host, env, prep.profile, m, prep.commit))
  }
  const deletes = plan.askDelete.filter(id => choices.deletes?.[id] === 'delete')
  const pseudo = (id: string): Item => {
    const m = prep.manifest.items[id]
    return local.byId.get(id) ?? { id, kind: m?.kind ?? 'setting', key: m?.key ?? id, label: m?.label ?? id, content: fetched.get(id) ?? {}, project: m?.project }
  }

  const config = [join(env, env.claudeDir, 'settings.json'), env.claudeJson]
  const touched = new Set<string>()
  const dirs = new Set<string>()
  for (const id of [...plan.put, ...deletes]) {
    const item = pseudo(id)
    if (!isFileKind(item.kind)) continue
    if (DIR_KINDS.has(item.kind)) dirs.add(fileBase(item, env, root))
    for (const w of fileWrites(item, fetched.get(id)?.files ?? item.content.files, env, target)) touched.add(w.path)
    for (const w of fileWrites(item, local.byId.get(id)?.content.files, env, target)) touched.add(w.path)
  }
  const before = await snapshot(host, env, touched, dirs)
  const whole: Record<string, string | undefined> = {}
  const originals: Record<string, Record<string, Json>> = {}
  const invalid = new Set<string>()
  for (const file of config) {
    whole[file] = await host.read(file)
    try { originals[file] = parseJson(whole[file], file) } catch { invalid.add(file) }
  }
  const json: Backup['json'] = {}
  const remember = (write: JsonWrite) => {
    const list = (json[write.file] ??= [])
    for (const edit of write.edits) {
      const path = editedPath(edit)
      if (list.some(e => e.path.join('\u0000') === path.join('\u0000'))) continue
      const value = getPath(originals[write.file], path)
      list.push(value === undefined ? { path } : { path, value: structuredClone(value) })
    }
  }
  const projects = (originals[env.claudeJson]?.projects ?? {}) as Record<string, Json>
  const installed: string[] = []
  const installedPlugins = async () => {
    try { return (parseJson(await host.read(join(env, env.claudeDir, 'plugins', 'installed_plugins.json'))).plugins ?? {}) as Record<string, { version?: string }[]> } catch { return {} }
  }
  const knownMarkets = async () => {
    try { return parseJson(await host.read(join(env, env.claudeDir, 'plugins', 'known_marketplaces.json'))) } catch { return {} }
  }

  const ordered = [...plan.put].sort((a, b) => {
    const rank = (id: string) => { const k = ORDER.indexOf(pseudo(id).kind); return k < 0 ? ORDER.length : k }
    return rank(a) - rank(b)
  })
  const skip = (id: string, reason: string) => summary.skipped.push({ id, reason })

  for (const id of ordered) {
    const item = pseudo(id)
    const m = prep.manifest.items[id]
    const content = fetched.get(id)
    if (!m || !content) continue
    try {
      if (isFileKind(item.kind)) {
        if (DIR_KINDS.has(item.kind)) await host.remove(fileBase(item, env, root))
        for (const w of fileWrites(item, content.files ?? {}, env, target)) await host.write(w.path, w.text ?? '')
      } else {
        const { value, missing } = fillMarkers(content.value ?? null, id, local.byId.get(id)?.content.value, values)
        if (missing.length > 0) { skip(id, `missing secret: ${missing.join(', ')}`); continue }
        const write: JsonWrite = valueEdits(item, value, env, target, projects)
        if (invalid.has(write.file)) { skip(id, `invalid JSON in ${write.file}`); continue }
        if (item.kind === 'marketplace' && !((await knownMarkets())[item.key])) {
          const source = marketplaceArg((value as { source?: Json })?.source)
          const added = source ? await host.run(['claude', 'plugin', 'marketplace', 'add', source], { timeoutMs: 300_000 }) : { code: 1, stderr: 'no source', stdout: '' }
          if (added.code !== 0) { skip(id, `marketplace add failed: ${added.stderr.trim() || added.stdout.trim()}`); continue }
        }
        if (item.kind === 'plugin') {
          const recorded = (value as { version?: string }).version
          if (!(await installedPlugins())[item.key]) {
            const r = await host.run(['claude', 'plugin', 'install', item.key, '--scope', 'user'], { timeoutMs: 600_000 })
            if (r.code !== 0) { skip(id, `install failed: ${r.stderr.trim() || r.stdout.trim()}`); continue }
            installed.push(item.key)
          }
          const now = (await installedPlugins())[item.key]?.[0]?.version
          if (recorded && now && now !== recorded) summary.warnings.push(`${item.key}: ${recorded} → ${now}`)
          const options: Record<string, string> = {}
          for (const option of m.sensitiveOptions ?? []) {
            const given = values[`${id}#option:${option}`]
            if (given) options[option] = given
          }
          if (Object.keys(options).length > 0) {
            const r = await host.run(['claude', 'plugin', 'configure', item.key, '--values-stdin'], { stdin: JSON.stringify(options) })
            if (r.code !== 0) summary.warnings.push(`${item.key}: configure failed`)
          }
        }
        remember(write)
        await applyJson(host, write)
      }
      summary.applied.push(id)
      if (RESTART.has(item.kind)) summary.restart = true
    } catch (error) {
      skip(id, error instanceof InvalidJson ? `invalid JSON: ${error.message}` : String((error as Error).message ?? error))
    }
  }

  for (const id of deletes) {
    const item = local.byId.get(id)
    if (!item) continue
    try {
      if (isFileKind(item.kind)) {
        if (DIR_KINDS.has(item.kind)) await host.remove(fileBase(item, env, root))
        else for (const w of fileWrites(item, undefined, env, target)) await host.remove(w.path)
      } else {
        const write = valueEdits(item, undefined, env, target, projects)
        if (invalid.has(write.file)) { skip(id, `invalid JSON in ${write.file}`); continue }
        remember(write)
        await applyJson(host, write)
      }
      summary.applied.push(`-${id}`)
    } catch (error) {
      skip(id, String((error as Error).message ?? error))
    }
  }

  const broken: string[] = []
  for (const path of [...touched, ...config]) {
    if (!path.endsWith('.json') || invalid.has(path)) continue
    const text = await host.read(path)
    if (text === undefined) continue
    try { JSON.parse(text) } catch { broken.push(path) }
  }
  if (broken.length > 0) {
    await restore(host, { files: before, json: {} })
    for (const file of config) if (whole[file] !== undefined && !invalid.has(file)) await host.write(file, whole[file] ?? '')
    for (const p of installed) await host.run(['claude', 'plugin', 'uninstall', p], { timeoutMs: 300_000 })
    return { applied: [], skipped: plan.put.map(id => ({ id, reason: `invalid JSON after applying (${broken.join(', ')}), restored` })), warnings: summary.warnings, restart: false }
  }

  await host.write(backupPath(env), JSON.stringify({ createdAt: new Date(host.now()).toISOString(), files: before, json, installed } satisfies Backup))
  const ps = profileState(ctx.state, prep.profile)
  const synced = { ...ps.synced }
  for (const id of summary.applied) {
    const m = prep.manifest.items[id]
    if (m) synced[id] = m.hash
  }
  for (const id of keepLocal) { const m = prep.manifest.items[id]; if (m) synced[id] = m.hash }
  for (const r of rows) if (r.status === 'same') synced[r.id] = prep.manifest.items[r.id]?.hash ?? ''
  const head = prep.commit ? ps.commit : await repo.headOf(host, env, prep.profile)
  await ctx.save({ ...ctx.state, profile: prep.profile, profiles: { ...ctx.state.profiles, [prep.profile]: { commit: head, synced } } })
  return summary
}

export async function undo (ctx: Ctx): Promise<boolean> {
  const text = await ctx.host.read(backupPath(ctx.env))
  if (!text) return false
  const backup = JSON.parse(text) as Backup
  await restore(ctx.host, backup)
  for (const p of backup.installed) await ctx.host.run(['claude', 'plugin', 'uninstall', p], { timeoutMs: 300_000 })
  await ctx.host.remove(backupPath(ctx.env))
  return true
}

export async function listProfiles (ctx: Ctx): Promise<string[]> {
  await repo.fetch(ctx.host, ctx.env).catch(() => undefined)
  return repo.profiles(ctx.host, ctx.env)
}

export async function switchProfile (ctx: Ctx, profile: string): Promise<void> {
  await ctx.save({ ...ctx.state, profile })
}

export async function createMix (ctx: Ctx, name: string, picks: readonly { profile: string; id: string }[]): Promise<Summary> {
  const { host, env } = ctx
  await repo.fetch(host, env)
  const names = [...new Set(picks.map(p => p.profile))]
  const sources = await Promise.all(names.map(async profile => ({ profile, manifest: await repo.readManifest(host, env, profile) })))
  const manifest = mix(sources, picks, name)
  await host.remove(join(env, repo.repoDir(env), 'profiles', name))
  const origin = new Map(picks.map(p => [p.id, p.profile]))
  for (const [id, item] of Object.entries(manifest.items)) {
    await repo.writeContent(host, env, name, item, await repo.readContent(host, env, origin.get(id) ?? name, item))
  }
  await repo.writeManifest(host, env, manifest)
  await repo.commitAndPush(host, env, `${name}: mix of ${names.join(', ')} (${Object.keys(manifest.items).length} item(s))\n`)
  return { applied: Object.keys(manifest.items), skipped: [], warnings: [], restart: false }
}

export const versions = (ctx: Ctx, profile: string) => repo.history(ctx.host, ctx.env, profile)
