import { atom, read, update } from 'claude-code'
import type { Elements, EngineInterface } from 'claude-code'

import type { ClaudeSyncChip, ClaudeSyncScreen } from '../types'
import * as app from './app'
import type { ItemDiff } from './diff'
import { engineHost } from './host'
import { detectLang, strings, type Lang, type Strings } from './i18n'
import type { Kind } from './inventory'
import { detectEnv, type Env } from './platform'
import { emptyState, planUpload, withRequired, type Row, type SyncState } from './profile'
import * as repo from './repo'
import type { Finding } from './secrets'

export const PANE = 'config-sync'
export const chipAtom = atom({ plugin: 'config-sync', key: 'chip' } as const, { isReady: false, pending: 0, incoming: false } as ClaudeSyncChip, { shape: 'chip-1' })
const screenAtom = atom({ plugin: 'config-sync', key: 'screen' } as const, { name: 'menu' } as ClaudeSyncScreen, { shape: 'screen-1' })

type Ask = { id: string; label: string }
type UploadFlow = { profile: string; answers: Record<string, 'remove' | 'keep'>; exceptions: string[]; findings: Finding[] }
type ImportFlow = { profile: string; commit?: string; sourceProject?: string; targetRoot?: string; projects: string[]; conflicts: Record<string, 'remote' | 'local'>; deletes: Record<string, 'delete' | 'keep'> }
type Tree = { name: 'tree'; mode: 'upload' | 'import' | 'mix'; title: string; rows: Row[]; checked: string[]; open: string[]; hidden: number; upload?: UploadFlow; import?: ImportFlow; mix?: string }
type Line = { label: string; kind: 'new' | 'replace' | 'delete'; diff?: ItemDiff }
type Screen =
  | { name: 'menu' }
  | { name: 'busy' }
  | { name: 'error'; text: string }
  | { name: 'setup'; tools?: repo.Tools; log?: string }
  | { name: 'profiles'; list: string[]; purpose: 'first' | 'switch' | 'history' }
  | Tree
  | { name: 'secrets'; tree: Tree; itemId: string }
  | { name: 'diff'; tree: Tree; title: string; diff: ItemDiff }
  | { name: 'ask'; kind: 'remove' | 'delete'; queue: Ask[]; tree: Tree }
  | { name: 'upload-first'; profile: string; pending: number }
  | { name: 'conflict'; tree: Tree; queue: Ask[]; diff: ItemDiff }
  | { name: 'review'; tree: Tree; lines: Line[] }
  | { name: 'values'; tree: Tree; asked: app.Asked[] }
  | { name: 'summary'; lines: string[]; canUndo: boolean }
  | { name: 'mix-name' }
  | { name: 'history'; profile: string; versions: repo.Version[] }

type El = Pick<Elements['terminal'], 'Box' | 'Text' | 'Button' | 'Input' | 'Select' | 'Code'>

const KIND_ORDER: Kind[] = ['claude-md', 'hook', 'script', 'permission', 'setting', 'skill', 'agent', 'command', 'keybindings', 'marketplace', 'plugin', 'plugin-data', 'mcp', 'project-file', 'project-skill', 'project-agent', 'project-command', 'project-config', 'memory']

let lang: Lang | undefined
let env: Env | undefined
let state: SyncState | undefined
let secretValues: Record<string, string> = {}
let busy = false

export async function language ($: EngineInterface): Promise<Strings> {
  if (!lang) {
    const setting = await $.settings.read({ key: 'language' }).catch(() => undefined)
    let runtime: string | undefined
    try { runtime = Intl.DateTimeFormat().resolvedOptions().locale } catch { runtime = undefined }
    lang = detectLang(setting, { LC_ALL: await $.env.get('LC_ALL'), LC_MESSAGES: await $.env.get('LC_MESSAGES'), LANG: await $.env.get('LANG') }, runtime)
  }
  return strings[lang]
}

async function context ($: EngineInterface): Promise<app.Ctx> {
  const host = engineHost($)
  env ??= await detectEnv(host)
  state ??= { ...emptyState(), ...((await $.store.get('state')) as SyncState | undefined) }
  return {
    host,
    env,
    cwd: await $.session.cwd(),
    get state () { return state ?? emptyState() },
    save: async next => { state = next; await $.store.set('state', next) }
  }
}

function show ($: EngineInterface, screen: Screen) {
  return update($, screenAtom, () => screen as ClaudeSyncScreen)
}

export async function refresh ($: EngineInterface, fetch = true): Promise<void> {
  const ctx = await context($)
  const chip = await app.status(ctx, fetch).catch(() => ({ isReady: Boolean(ctx.state.repo && ctx.state.profile), profile: ctx.state.profile, pending: 0, incoming: false }))
  await update($, chipAtom, () => chip)
}

async function run ($: EngineInterface, work: () => Promise<Screen>): Promise<void> {
  if (busy) return
  busy = true
  await show($, { name: 'busy' })
  try {
    await show($, await work())
  } catch (error) {
    const t = await language($)
    await show($, { name: 'error', text: error instanceof app.SecretLeak ? t.leak : String((error as Error).message ?? error) })
  } finally {
    busy = false
  }
  void refresh($, false)
}

export async function openPane ($: EngineInterface): Promise<void> {
  const ctx = await context($)
  await show($, ctx.state.repo && ctx.state.profile ? { name: 'menu' } : { name: 'setup' })
  await $.ui.open({ id: PANE, title: 'Claude Sync', focus: true, closeOnEscape: true })
  if (!ctx.state.repo || !ctx.state.profile) void run($, async () => setupScreen($))
}

async function setupScreen ($: EngineInterface, log?: string): Promise<Screen> {
  const ctx = await context($)
  const tools = await repo.checkTools(ctx.host)
  if (ctx.state.repo && tools.ghAuthed) return { name: 'profiles', list: await app.listProfiles(ctx), purpose: 'first' }
  return { name: 'setup', tools, log }
}

async function signIn ($: EngineInterface): Promise<void> {
  let log = ''
  await show($, { name: 'setup', log })
  try {
    const login = $.process.spawn({ argv: ['gh', 'auth', 'login', '--web', '--hostname', 'github.com', '--git-protocol', 'https'], input: '\n' })
    for await (const chunk of login) {
      log = (log + chunk.text).slice(-1500)
      await show($, { name: 'setup', log })
    }
  } catch (error) {
    log += `\n${String(error)}`
  }
  await run($, () => setupScreen($, log))
}

async function connect ($: EngineInterface, login: string): Promise<Screen> {
  const ctx = await context($)
  const full = await repo.ensureRepo(ctx.host, ctx.env, login)
  await ctx.save({ ...ctx.state, repo: full })
  return { name: 'profiles', list: await app.listProfiles(ctx), purpose: 'first' }
}

const visible = (rows: Row[], mode: Tree['mode']) => (mode === 'mix' ? rows : rows.filter(r => r.status !== 'same'))

async function uploadTree ($: EngineInterface, profile: string, checkAll = false): Promise<Screen> {
  const t = await language($)
  const prep = await app.prepareUpload(await context($), profile, checkAll)
  const rows = visible(prep.rows, 'upload')
  return { name: 'tree', mode: 'upload', title: t.treeUpload(profile), rows, checked: rows.filter(r => r.checked).map(r => r.id), open: [], hidden: prep.rows.length - rows.length, upload: { profile, answers: {}, exceptions: [], findings: prep.findings } }
}

let importPrep: app.ImportPrep | undefined

async function importTree ($: EngineInterface, flow: Pick<ImportFlow, 'profile' | 'commit' | 'sourceProject' | 'targetRoot'>): Promise<Screen> {
  const t = await language($)
  const ctx = await context($)
  importPrep = await app.prepareImport(ctx, flow.profile, flow.commit, flow.sourceProject, flow.targetRoot)
  const rows = visible(importPrep.rows, 'import')
  return {
    name: 'tree', mode: 'import', title: t.treeImport(flow.profile) + (flow.commit ? ` @ ${flow.commit.slice(0, 7)}` : ''), rows,
    checked: rows.filter(r => r.checked).map(r => r.id), open: [], hidden: importPrep.rows.length - rows.length,
    import: { ...flow, sourceProject: importPrep.sourceProject, targetRoot: importPrep.targetRoot, projects: importPrep.projects, conflicts: {}, deletes: {} }
  }
}

async function prep ($: EngineInterface, flow: ImportFlow): Promise<app.ImportPrep> {
  if (importPrep && importPrep.profile === flow.profile && importPrep.commit === flow.commit && importPrep.sourceProject === flow.sourceProject && importPrep.targetRoot === flow.targetRoot) return importPrep
  importPrep = await app.prepareImport(await context($), flow.profile, flow.commit, flow.sourceProject, flow.targetRoot)
  return importPrep
}

async function startImport ($: EngineInterface, profile: string, commit?: string): Promise<Screen> {
  const ctx = await context($)
  if (!commit && ctx.state.profile === profile) {
    const chip = await app.status(ctx)
    if (chip.pending > 0) return { name: 'upload-first', profile, pending: chip.pending }
  }
  return importTree($, { profile, commit })
}

const labelOf = (tree: Tree, id: string) => tree.rows.find(r => r.id === id)?.label ?? id

async function continueTree ($: EngineInterface, tree: Tree): Promise<Screen> {
  const t = await language($)
  const selected = new Set(tree.checked)
  if (selected.size === 0) return { name: 'error', text: t.nothingSelected }
  if (tree.mode === 'mix') {
    const picks = tree.checked.map(id => { const [profile = '', item = ''] = id.split('\u001f'); return { profile, id: item } })
    const summary = await app.createMix(await context($), tree.mix ?? 'mix', picks)
    return summaryScreen($, summary, tree, false)
  }
  if (tree.mode === 'upload') {
    const plan = planUpload(tree.rows, withRequired(tree.rows, selected))
    const queue = plan.askRemove.filter(id => !tree.upload?.answers[id]).map(id => ({ id, label: labelOf(tree, id) }))
    if (queue.length > 0) return { name: 'ask', kind: 'remove', queue, tree }
    const flow = tree.upload as UploadFlow
    const summary = await app.upload(await context($), flow.profile, selected, flow.answers, flow.exceptions)
    return summaryScreen($, summary, tree, false)
  }
  const flow = tree.import as ImportFlow
  const conflicts = tree.rows.filter(r => selected.has(r.id) && r.status === 'conflict' && !flow.conflicts[r.id])
  if (conflicts.length > 0) {
    const queue = conflicts.map(r => ({ id: r.id, label: r.label }))
    return { name: 'conflict', tree, queue, diff: await app.diffFor(await context($), await prep($, flow), conflicts[0]?.id ?? '') }
  }
  const ctx = await context($)
  const p = await prep($, flow)
  const deletions = (await app.deletionCandidates(ctx, p, selected)).filter(a => !flow.deletes[a.id])
  if (deletions.length > 0) return { name: 'ask', kind: 'delete', queue: deletions, tree }
  const asked = (await app.missingSecrets(ctx, p, withRequired(tree.rows, selected))).filter(a => secretValues[a.name] === undefined)
  if (asked.length > 0) return { name: 'values', tree, asked }
  const lines: Line[] = []
  for (const id of withRequired(tree.rows, selected)) {
    const row = tree.rows.find(r => r.id === id)
    if (!row || row.status === 'other-os' || (row.status === 'conflict' && flow.conflicts[id] !== 'remote')) continue
    lines.push(row.status === 'new' ? { label: row.label, kind: 'new' } : { label: row.label, kind: 'replace', diff: await app.diffFor(ctx, p, id) })
  }
  for (const [id, answer] of Object.entries(flow.deletes)) if (answer === 'delete') lines.push({ label: id, kind: 'delete' })
  return { name: 'review', tree, lines }
}

async function apply ($: EngineInterface, tree: Tree): Promise<Screen> {
  const flow = tree.import as ImportFlow
  const summary = await app.importItems(await context($), await prep($, flow), { selected: new Set(tree.checked), conflicts: flow.conflicts, deletes: flow.deletes, values: secretValues })
  secretValues = {}
  importPrep = undefined
  return summaryScreen($, summary, tree, true)
}

async function summaryScreen ($: EngineInterface, summary: app.Summary, tree: Tree, canUndo: boolean): Promise<Screen> {
  const t = await language($)
  const lines = [t.applied(summary.applied.length), ...summary.skipped.map(s => t.skipped(labelOf(tree, s.id), s.reason)), ...summary.warnings.map(t.warning)]
  if (summary.restart) lines.push(t.restart)
  return { name: 'summary', lines, canUndo: canUndo && summary.applied.length > 0 }
}

async function mixTree ($: EngineInterface, name: string): Promise<Screen> {
  const t = await language($)
  const ctx = await context($)
  const rows: Row[] = []
  for (const profile of await app.listProfiles(ctx)) {
    const manifest = await repo.readManifest(ctx.host, ctx.env, profile)
    for (const [id, m] of Object.entries(manifest.items)) rows.push({ id: `${profile}\u001f${id}`, kind: m.kind, label: m.label, project: `${profile}${m.project ? ` · ${m.project}` : ''}`, status: 'new', checked: false })
  }
  return { name: 'tree', mode: 'mix', title: t.treeMix(name), rows, checked: [], open: [], hidden: 0, mix: name }
}

function categories (tree: Tree, t: Strings): { key: string; label: string; rows: Row[] }[] {
  const groups = new Map<string, Row[]>()
  for (const row of tree.rows) {
    const key = `${row.project ?? ''}\u001f${row.kind}`
    groups.set(key, [...(groups.get(key) ?? []), row])
  }
  const rank = (key: string) => { const [project = '', kind = ''] = key.split('\u001f'); return `${project ? 1 : 0}${project}\u001f${String(KIND_ORDER.indexOf(kind as Kind)).padStart(2, '0')}` }
  return [...groups].sort(([a], [b]) => (rank(a) < rank(b) ? -1 : 1)).map(([key, rows]) => {
    const [project = '', kind = ''] = key.split('\u001f')
    return { key, label: `${project ? `${project} · ` : ''}${t.kind[kind as Kind]}`, rows }
  })
}

const toggle = (list: string[], id: string, on?: boolean) => (on ?? !list.includes(id) ? [...new Set([...list, id])] : list.filter(x => x !== id))

function treeView ($: EngineInterface, el: El, t: Strings, tree: Tree) {
  const { Box, Text, Button, Input, Select } = el
  const set = (patch: Partial<Tree>) => show($, { ...tree, ...patch })
  const flow = tree.import
  return (
    <Box flexDirection="column">
      <Text bold>{tree.title}</Text>
      {flow && flow.projects.length > 0
        ? (
          <Box flexDirection="column">
            <Select key="project" label={t.projectFrom} value={flow.sourceProject ?? ''} options={[...flow.projects.map(p => ({ value: p })), { value: '', label: t.noProject }]}
              onSelect={value => { void run($, () => importTree($, { ...flow, sourceProject: value || undefined })) }} />
            <Input key="target" label={t.applyTo} value={flow.targetRoot ?? ''} onSubmit={value => { void run($, () => importTree($, { ...flow, targetRoot: value.trim() || undefined })) }} />
          </Box>
          )
        : null}
      {categories(tree, t).map((cat, index) => {
        const isOpen = tree.open.includes(cat.key)
        const count = cat.rows.filter(r => tree.checked.includes(r.id)).length
        return (
          <Box flexDirection="column">
            <Box flexDirection="row">
              <Button key={`cat:${cat.key}`} plain autoFocus={index === 0 ? true : undefined} onPress={() => { void set({ open: toggle(tree.open, cat.key) }) }}>{isOpen ? '▾ ' : '▸ '}{cat.label} <Text dimColor>({count}/{cat.rows.length})</Text></Button>
              <Text> </Text>
              <Button key={`all:${cat.key}`} plain dimColor onPress={() => { void set({ checked: cat.rows.filter(r => r.status !== 'secret' && r.status !== 'other-os').reduce((l, r) => toggle(l, r.id, true), tree.checked) }) }}>{t.all}</Button>
              <Text dimColor> / </Text>
              <Button key={`none:${cat.key}`} plain dimColor onPress={() => { void set({ checked: cat.rows.reduce((l, r) => toggle(l, r.id, false), tree.checked) }) }}>{t.none}</Button>
            </Box>
            {isOpen
              ? cat.rows.map(row => (
                <Box flexDirection="row">
                  <Button key={`row:${row.id}`} plain onPress={() => {
                    if (row.status === 'secret') void show($, { name: 'secrets', tree, itemId: row.id })
                    else void set({ checked: toggle(tree.checked, row.id) })
                  }}>
                    {'  '}{tree.checked.includes(row.id) ? '[x] ' : '[ ] '}{row.label}
                    {t.status[row.status] && tree.mode !== 'mix' ? <Text color={row.status === 'secret' || row.status === 'conflict' || row.status === 'other-os' ? 'warning' : undefined} dimColor={row.status === 'not-in-profile'}> · {t.status[row.status]}</Text> : ''}
                    {row.inProjectGit ? <Text dimColor> · {t.inProjectGit}</Text> : ''}
                  </Button>
                  {tree.mode === 'import' && row.status !== 'new' && row.status !== 'same'
                    ? <Button key={`diff:${row.id}`} plain dimColor onPress={() => { void run($, async () => ({ name: 'diff', tree, title: row.label, diff: await app.diffFor(await context($), await prep($, tree.import as ImportFlow), row.id) })) }}>{`  ${t.diff}`}</Button>
                    : null}
                </Box>
                ))
              : null}
          </Box>
        )
      })}
      {tree.hidden > 0 ? <Text dimColor>{t.hiddenSame(tree.hidden)}</Text> : null}
      <Box flexDirection="row">
        <Button key="continue" variant="primary" autoFocus={tree.rows.length === 0 ? true : undefined} onPress={() => { void run($, () => continueTree($, tree)) }}>{t.continue}</Button>
        <Text> </Text>
        <Button key="back" onPress={() => { void show($, { name: 'menu' }) }}>{t.back}</Button>
      </Box>
    </Box>
  )
}

function diffView (el: El, t: Strings, diff: ItemDiff) {
  const { Box, Text, Code } = el
  if (diff.text) return <Code format="diff" source={diff.text} />
  return (
    <Box flexDirection="column">
      {(diff.fields ?? []).map(f => (
        <Text color={f.op === '+' ? 'success' : f.op === '-' ? 'error' : 'warning'}>
          {f.op} {f.path || '(value)'}{f.op === '~' ? `: ${JSON.stringify(f.before)} → ${JSON.stringify(f.after)}` : `: ${JSON.stringify(f.op === '+' ? f.after : f.before)}`}
        </Text>
      ))}
      {(diff.fields ?? []).length === 0 ? <Text dimColor>{t.upToDate}</Text> : null}
    </Box>
  )
}

export async function draw ($: EngineInterface, e: Parameters<EngineInterface['ui']['resolve']>[0]) {
  const t = await language($)
  const table = $.ui.resolve(e)
  if (e.surface === 'mobile') { const { Text } = table as Elements['mobile']; return <Text>{t.mobile}</Text> }
  const el = table as unknown as El
  const { Box, Text, Button, Input } = el
  const screen = (await read($, screenAtom)) as Screen
  const chip = await read($, chipAtom)
  const menu = () => { void show($, { name: 'menu' }) }
  const backButton = <Button key="back" onPress={menu}>{t.back}</Button>

  switch (screen.name) {
    case 'busy': return <Text dimColor>{t.working}</Text>
    case 'error': return <Box flexDirection="column"><Text bold color="error">{t.errorTitle}</Text><Text>{screen.text}</Text>{backButton}</Box>
    case 'setup': {
      const tools = screen.tools
      return (
        <Box flexDirection="column">
          <Text bold>{t.setupTitle}</Text>
          <Text dimColor>{t.setupIntro}</Text>
          {tools ? <Text>{tools.git ? t.toolOk('git') : t.toolMissing('git')}</Text> : null}
          {tools ? <Text>{tools.gh ? t.toolOk('gh') : t.toolMissing('gh')}</Text> : null}
          {tools?.gh ? <Text>{tools.ghAuthed ? t.loggedIn(tools.login ?? '') : t.needLogin}</Text> : null}
          {screen.log ? <Text dimColor>{screen.log}</Text> : null}
          {tools?.gh && !tools.ghAuthed ? <Text dimColor>{t.signInManual}</Text> : null}
          <Box flexDirection="row">
            {tools?.git && tools.ghAuthed && tools.login ? <Button key="connect" variant="primary" autoFocus onPress={() => { void run($, () => connect($, tools.login ?? '')) }}>{t.connect(`${tools.login}/${repo.REPO_NAME}`)}</Button> : null}
            {tools?.gh && !tools.ghAuthed ? <Button key="signin" variant="primary" autoFocus onPress={() => { void signIn($) }}>{t.signIn}</Button> : null}
            <Text> </Text>
            <Button key="check" onPress={() => { void run($, () => setupScreen($)) }}>{t.checkAgain}</Button>
          </Box>
        </Box>
      )
    }
    case 'profiles': {
      const active = (await context($)).state.profile
      return (
        <Box flexDirection="column">
          <Text bold>{t.profilesTitle}</Text>
          {screen.purpose === 'first' ? <Text dimColor>{t.profilesFirst}</Text> : null}
          {screen.list.map(name => (
            <Button key={`p:${name}`} plain onPress={() => {
              void run($, async () => {
                if (screen.purpose === 'history') return { name: 'history', profile: name, versions: await app.versions(await context($), name) }
                await app.switchProfile(await context($), name)
                return startImport($, name)
              })
            }}>{name}{name === active ? <Text dimColor> · {t.active}</Text> : ''}</Button>
          ))}
          {screen.purpose !== 'history'
            ? <Input key="new" label={t.newProfile} placeholder={t.newProfileHint} submitLabel={t.create} autoFocus={screen.list.length === 0 ? true : undefined}
                onSubmit={value => {
                  const name = value.trim().replace(/[^\p{L}\p{N}._-]+/gu, '-')
                  if (!name) return
                  void run($, async () => { await app.switchProfile(await context($), name); return uploadTree($, name, true) })
                }} />
            : null}
          {screen.purpose === 'first' ? null : backButton}
        </Box>
      )
    }
    case 'tree': return treeView($, el, t, screen)
    case 'secrets': {
      const findings = (screen.tree.upload?.findings ?? []).filter(f => f.itemId === screen.itemId && !screen.tree.upload?.exceptions.includes(f.hash))
      const back = (tree: Tree) => { void show($, tree) }
      return (
        <Box flexDirection="column">
          <Text bold color="warning">{t.secretsTitle}: {labelOf(screen.tree, screen.itemId)}</Text>
          <Text dimColor>{t.secretsIntro}</Text>
          {findings.map(f => (
            <Box flexDirection="row">
              <Text>{t.finding(f.file, f.line, f.preview)}  </Text>
              <Button key={`ok:${f.hash}`} onPress={() => {
                const upload = screen.tree.upload as UploadFlow
                const exceptions = [...upload.exceptions, f.hash]
                const left = upload.findings.filter(x => x.itemId === screen.itemId && !exceptions.includes(x.hash))
                const rows = left.length > 0 ? screen.tree.rows : screen.tree.rows.map(r => (r.id === screen.itemId ? { ...r, status: 'not-in-profile' as const } : r))
                const tree = { ...screen.tree, rows, checked: left.length > 0 ? screen.tree.checked : toggle(screen.tree.checked, screen.itemId, true), upload: { ...upload, exceptions } }
                if (left.length > 0) void show($, { ...screen, tree })
                else back(tree)
              }}>{t.notSecret}</Button>
            </Box>
          ))}
          <Button key="back" onPress={() => back(screen.tree)}>{t.back}</Button>
        </Box>
      )
    }
    case 'diff': return <Box flexDirection="column"><Text bold>{screen.title}</Text>{diffView(el, t, screen.diff)}<Button key="back" autoFocus onPress={() => { void show($, screen.tree) }}>{t.back}</Button></Box>
    case 'ask': {
      const [head, ...rest] = screen.queue
      if (!head) return <Text dimColor>{t.working}</Text>
      const answer = (value: string, all: boolean) => {
        const ids = all ? screen.queue.map(q => q.id) : [head.id]
        const tree = { ...screen.tree }
        if (screen.kind === 'remove') tree.upload = { ...(tree.upload as UploadFlow), answers: { ...tree.upload?.answers, ...Object.fromEntries(ids.map(id => [id, value as 'remove' | 'keep'])) } }
        else tree.import = { ...(tree.import as ImportFlow), deletes: { ...tree.import?.deletes, ...Object.fromEntries(ids.map(id => [id, value as 'delete' | 'keep'])) } }
        const left = all ? [] : rest
        if (left.length > 0) void show($, { ...screen, queue: left, tree })
        else void run($, () => continueTree($, tree))
      }
      const [yes, no] = screen.kind === 'remove' ? ['remove', 'keep'] : ['delete', 'keep']
      return (
        <Box flexDirection="column">
          <Text bold>{screen.kind === 'remove' ? t.removeTitle : t.deleteTitle}</Text>
          <Text>{screen.kind === 'remove' ? t.removeText(head.label) : t.deleteText(head.label)}</Text>
          <Box flexDirection="row">
            <Button key="no" autoFocus onPress={() => answer(no ?? 'keep', false)}>{screen.kind === 'remove' ? t.keep : t.keepHere}</Button>
            <Text> </Text>
            <Button key="yes" onPress={() => answer(yes ?? 'keep', false)}>{screen.kind === 'remove' ? t.remove : t.delete}</Button>
          </Box>
          {rest.length > 0
            ? <Box flexDirection="row"><Text dimColor>{t.applyAll}: </Text><Button key="no-all" plain onPress={() => answer(no ?? 'keep', true)}>{screen.kind === 'remove' ? t.keep : t.keepHere}</Button><Text dimColor> / </Text><Button key="yes-all" plain onPress={() => answer(yes ?? 'keep', true)}>{screen.kind === 'remove' ? t.remove : t.delete}</Button></Box>
            : null}
        </Box>
      )
    }
    case 'upload-first':
      return (
        <Box flexDirection="column">
          <Text bold>{t.uploadFirstTitle}</Text>
          <Text>{t.uploadFirstText(screen.pending)}</Text>
          <Box flexDirection="row">
            <Button key="up" variant="primary" autoFocus onPress={() => { void run($, () => uploadTree($, screen.profile)) }}>{t.uploadFirst}</Button>
            <Text> </Text>
            <Button key="skip" onPress={() => { void run($, () => importTree($, { profile: screen.profile })) }}>{t.skipUpload}</Button>
          </Box>
        </Box>
      )
    case 'conflict': {
      const [head, ...rest] = screen.queue
      if (!head) return <Text dimColor>{t.working}</Text>
      const pick = (value: 'remote' | 'local') => {
        const tree = { ...screen.tree, import: { ...(screen.tree.import as ImportFlow), conflicts: { ...screen.tree.import?.conflicts, [head.id]: value } } }
        void run($, async () => (rest.length > 0 ? { name: 'conflict', tree, queue: rest, diff: await app.diffFor(await context($), await prep($, tree.import), rest[0]?.id ?? '') } : continueTree($, tree)))
      }
      return (
        <Box flexDirection="column">
          <Text bold color="warning">{t.conflictTitle(head.label)}</Text>
          <Text dimColor>{t.conflictText}</Text>
          {diffView(el, t, screen.diff)}
          <Box flexDirection="row">
            <Button key="remote" autoFocus onPress={() => pick('remote')}>{t.useRemote}</Button>
            <Text> </Text>
            <Button key="local" onPress={() => pick('local')}>{t.useLocal}</Button>
          </Box>
        </Box>
      )
    }
    case 'values':
      return (
        <Box flexDirection="column">
          <Text bold>{t.valuesTitle}</Text>
          <Text dimColor>{t.valuesIntro}</Text>
          {screen.asked.map((a, i) => (
            <Input key={`v:${a.name}`} label={a.label} autoFocus={i === 0 ? true : undefined} onInput={value => { secretValues[a.name] = value }} onSubmit={value => { secretValues[a.name] = value }} />
          ))}
          <Button key="continue" variant="primary" onPress={() => {
            for (const a of screen.asked) secretValues[a.name] ??= ''
            void run($, () => continueTree($, screen.tree))
          }}>{t.continue}</Button>
        </Box>
      )
    case 'review':
      return (
        <Box flexDirection="column">
          <Text bold>{t.reviewTitle}</Text>
          <Text dimColor>{t.reviewIntro}</Text>
          {screen.lines.map(line => (line.kind === 'replace' && line.diff
            ? <Box flexDirection="column"><Text bold>{line.label}</Text>{diffView(el, t, line.diff)}</Box>
            : <Text>{line.kind === 'new' ? t.reviewNew(line.label) : t.reviewDelete(line.label)}</Text>))}
          <Box flexDirection="row">
            <Button key="apply" variant="primary" autoFocus onPress={() => { void run($, () => apply($, screen.tree)) }}>{t.apply}</Button>
            <Text> </Text>
            <Button key="back" onPress={() => { void show($, screen.tree) }}>{t.back}</Button>
          </Box>
        </Box>
      )
    case 'summary':
      return (
        <Box flexDirection="column">
          <Text bold>{t.summaryTitle}</Text>
          {screen.lines.map(line => <Text>{line}</Text>)}
          <Box flexDirection="row">
            <Button key="menu" variant="primary" autoFocus onPress={menu}>{t.back}</Button>
            {screen.canUndo ? <Text> </Text> : null}
            {screen.canUndo ? <Button key="undo" onPress={() => { void run($, async () => ({ name: 'summary', lines: [(await app.undo(await context($))) ? t.undone : t.nothingToUndo], canUndo: false })) }}>{t.menuUndo}</Button> : null}
          </Box>
        </Box>
      )
    case 'mix-name':
      return (
        <Box flexDirection="column">
          <Input key="mix" label={t.mixName} autoFocus onSubmit={value => {
            const name = value.trim().replace(/[^\p{L}\p{N}._-]+/gu, '-')
            if (name) void run($, () => mixTree($, name))
          }} />
          {backButton}
        </Box>
      )
    case 'history':
      return (
        <Box flexDirection="column">
          <Text bold>{t.historyTitle(screen.profile)}</Text>
          {screen.versions.length === 0 ? <Text dimColor>{t.noVersions}</Text> : null}
          {screen.versions.map(v => (
            <Button key={`v:${v.commit}`} plain onPress={() => { void run($, () => importTree($, { profile: screen.profile, commit: v.commit })) }}>
              <Text dimColor>{v.date.slice(0, 16).replace('T', ' ')} </Text>{v.message}
            </Button>
          ))}
          {backButton}
        </Box>
      )
    default: {
      const ctx = await context($)
      const profile = ctx.state.profile ?? ''
      const undoable = await app.hasBackup(ctx)
      const entry = (key: string, label: string, work: () => Promise<Screen>, hotkey: string) =>
        <Button key={key} plain hotkey={hotkey} onPress={() => { void run($, work) }}>{label}</Button>
      return (
        <Box flexDirection="column">
          <Text bold>{t.title} · {t.profile(profile)}</Text>
          <Text color="claude">{chip.pending > 0 || chip.incoming ? [chip.pending > 0 ? t.pending(chip.pending) : '', chip.incoming ? t.incoming : ''].filter(Boolean).join(' · ') : t.upToDate}</Text>
          {entry('upload', t.menuUpload, () => uploadTree($, profile), '1')}
          {entry('import', t.menuImport, () => startImport($, profile), '2')}
          {entry('switch', t.menuSwitch, async () => ({ name: 'profiles', list: await app.listProfiles(await context($)), purpose: 'switch' }), '3')}
          <Button key="mix" plain hotkey="4" onPress={() => { void show($, { name: 'mix-name' }) }}>{t.menuMix}</Button>
          {entry('history', t.menuHistory, async () => ({ name: 'history', profile, versions: await app.versions(await context($), profile) }), '5')}
          {undoable ? entry('undo', t.menuUndo, async () => ({ name: 'summary', lines: [(await app.undo(await context($))) ? t.undone : t.nothingToUndo], canUndo: false }), '6') : null}
          <Button key="close" plain dimColor onPress={() => { void $.ui.close({ id: PANE }) }}>{t.close}</Button>
        </Box>
      )
    }
  }
}

export async function chip ($: EngineInterface, e: Parameters<EngineInterface['ui']['resolve']>[0], beneath: unknown) {
  const t = await language($)
  const c = await read($, chipAtom)
  const { Box, Text, Button } = $.ui.resolve(e) as unknown as El
  const marks = `${c.pending > 0 ? '●' : ''}${c.incoming ? '↓' : ''}`
  return (
    <Box flexDirection="row">
      <Button key="config-sync-chip" plain onPress={() => { void openPane($) }}>
        {'⇅ '}{c.isReady ? c.profile ?? '' : t.chipSetup}{marks ? <Text color="claude">{` ${marks}`}</Text> : ''}
      </Button>
      {beneath ? <Text dimColor> · </Text> : null}
      {beneath as never}
    </Box>
  )
}

