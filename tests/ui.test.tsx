import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import { strings } from '../hooks/i18n'
import { primaryKey } from '../hooks/ui'

const MODE = { plugin: 'config-sync', component: 'SessionMode', requestId: 'mode', props: { modes: [] } } as const
const PANE = { plugin: 'config-sync', component: 'Pane', requestId: 'config-sync', props: { title: 'Claude Sync', isFocused: true, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} } } as const
const STATE = { repo: 'me/claude-sync-config', profile: 'casa', profiles: {}, exceptions: [] }
const ENV: Record<string, string> = { LANG: 'es_ES.UTF-8', HOME: '/home/u' }

const CHIP = { shape: 'chip-1', value: { isReady: true, profile: 'casa', pending: 3, incoming: true } }

type Seen = { opened: { focus?: boolean }[]; closed: number; ran: string[] }
type Options = { state?: unknown; pane?: { isOpen: boolean; isFocused: boolean }; run?: (argv: readonly string[]) => { exitCode: number; stdout: string } }

function engine (on: On, seeds: Record<string, unknown> = {}, opened: unknown[] = [], options: Options = {}, seen?: Seen) {
  on('state.get', async (_, e, next) => {
    const read = await next(e)
    const seed = seeds[e.key]
    const isUnset = 'value' in read && (read.value?.version ?? 0) === 0
    return seed !== undefined && isUnset ? ({ value: { value: seed, version: 0 } } as typeof read) : read
  })
  on('env.get', (_, e) => ({ value: ENV[e.name] }))
  on('settings.read', () => ({ value: {} }))
  on('process.run', (_, e) => {
    seen?.ran.push(e.argv.join(' '))
    const r = e.argv[0] === 'uname' ? { exitCode: 0, stdout: 'Linux\n' } : options.run?.(e.argv) ?? { exitCode: 1, stdout: '' }
    return { value: { ...r, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('store.get', (_, e) => ({ value: e.key === 'state' ? ('state' in options ? options.state : STATE) : undefined }))
  on('store.set', () => ({ value: undefined }))
  on('fs.write', () => ({ value: undefined }))
  const pane = options.pane ?? { isOpen: false, isFocused: false }
  on('ui.panes', () => ({ value: pane.isOpen ? [{ id: 'config-sync', title: 'Claude Sync', isShown: true, isFocused: pane.isFocused, isPlaced: true }] : [] }))
  on('ui.close', () => { pane.isOpen = false; pane.isFocused = false; if (seen) seen.closed++; return { value: undefined } })
  on('session.cwd', () => ({ value: '/home/u' }))
  on('ui.log', () => ({ value: undefined }))
  on('fs.exists', () => ({ value: false }))
  on('fs.list', () => ({ value: [] }))
  on('ui.open', (_, e) => {
    opened.push(e)
    seen?.opened.push(e)
    if (!pane.isOpen) Object.assign(pane, { isOpen: true, isFocused: e.focus === true })
    return { value: { isPlaced: true } }
  })
  on('ui.render', ($, e) => { const { Text } = $.ui.resolve(e); return <Text>⏵⏵ bypass permissions on</Text> })
}

test('the footer chip shows the profile and its marks, and opens the menu', async ($, on) => {
  const opened: { focus?: boolean }[] = []
  engine(on, { chip: CHIP }, opened)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...MODE, surface })
    expect((await ui.find({ key: 'config-sync-chip' }))?.text).toBe('⇅ casa ●↓')
    await ui.unmount()
  }
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...MODE, surface })
    await ui.press({ key: 'config-sync-chip' })
    await ui.unmount()
  }
  expect(opened.length).toBe(2)
  expect(opened[0]?.focus).toBe(true)
})

test('before setup the chip invites to sync', async ($, on) => {
  engine(on)
  const ui = await $.ui.mount({ ...MODE, surface: 'terminal' })
  expect((await ui.find({ key: 'config-sync-chip' }))?.text).toBe('⇅ sync')
  await ui.unmount()
})

test('the menu lists the five operations in Spanish', async ($, on) => {
  engine(on, { chip: CHIP })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const labels = (await ui.findAll({ type: 'Button' })).map(b => b.text)
  expect(labels).toEqual(['Subir cambios', 'Traer del repo', 'Cambiar de perfil', 'Crear perfil mezclando otros', 'Historial de versiones', 'Cerrar'])
  expect((await ui.find({ type: 'Text', text: /sin subir/ }))?.text).toBe('● 3 cambio(s) sin subir · ↓ novedades en el repo')
  await ui.unmount()
})

test('the tree opens a category and toggles items and whole categories', async ($, on) => {
  const rows = [
    { id: 'skill:a', kind: 'skill', label: 'a', status: 'modified', checked: true },
    { id: 'skill:b', kind: 'skill', label: 'b', status: 'not-in-profile', checked: false },
    { id: 'memory:x', kind: 'memory', label: 'x.md', project: 'github.com/U/app', status: 'secret', checked: false }
  ]
  const tree = { name: 'tree', mode: 'upload', title: 'Subir a «casa»', rows, checked: ['skill:a'], open: [], hidden: 2, upload: { profile: 'casa', answers: {}, exceptions: [], findings: [] } }
  engine(on, { screen: { shape: 'screen-1', value: tree } })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const cat = 'cat:\u001fskill'
  expect((await ui.find({ key: cat }))?.text).toBe('▸ Skills (1/2)')
  await ui.press({ key: cat })
  expect((await ui.find({ key: 'row:skill:b' }))?.text).toBe('  [ ] b · no está en el perfil')
  await ui.press({ key: 'row:skill:b' })
  expect((await ui.find({ key: 'row:skill:b' }))?.text).toBe('  [x] b · no está en el perfil')
  await ui.press({ key: 'none:\u001fskill' })
  expect((await ui.find({ key: cat }))?.text).toBe('▾ Skills (0/2)')
  await ui.press({ key: 'cat:github.com/U/app\u001fmemory' })
  await ui.press({ key: 'all:github.com/U/app\u001fmemory' })
  expect((await ui.find({ key: 'row:memory:x' }))?.text).toBe('  [ ] x.md · ⚠ secreto')
  expect((await ui.find({ type: 'Text', text: /no se muestran/ }))?.text).toBe('2 elemento(s) sin cambios no se muestran')
  await ui.unmount()
})

const seen = (): Seen => ({ opened: [], closed: 0, ran: [] })
const screen = (value: unknown) => ({ screen: { shape: 'screen-1', value } })
const succeed = () => ({ exitCode: 0, stdout: '' })

test('after the repository is set up the pane asks for the keys again and shows the new profile field', async ($, on) => {
  const s = seen()
  engine(on, screen({ name: 'setup', tools: { git: true, gh: true, ghAuthed: true, login: 'me' } }), [], { state: undefined, run: succeed, pane: { isOpen: true, isFocused: false } }, s)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ key: 'connect' }))?.text).toBe('Usar me/claude-sync-config')
  await ui.press({ key: 'connect' })
  expect((await ui.find({ key: 'new' }))?.type).toBe('Input')
  expect(primaryKey({ name: 'profiles', list: [], purpose: 'first' }, strings.es)).toBe('new')
  expect(s.opened.length > 0).toBe(true)
  expect(s.opened.every(o => o.focus === true)).toBe(true)
  expect(s.closed).toBe(0)
  await ui.unmount()
})

test('while it works the pane still has a control to hold the keys', async ($, on) => {
  engine(on, screen({ name: 'busy' }))
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ key: 'busy' }))?.type).toBe('Button')
  await ui.unmount()
})

test('/sync with the pane already open opens it afresh to take the keys and checks local and remote changes again', async ($, on) => {
  const s = seen()
  const clock = mock.clock(on)
  engine(on, { chip: CHIP }, [], { run: succeed, pane: { isOpen: true, isFocused: false } }, s)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /sin subir/ }))?.text).toBe('● 3 cambio(s) sin subir · ↓ novedades en el repo')
  await $.command.run({ command: 'sync' })
  await clock.settle()
  expect(s.ran).toContain('git fetch --prune origin')
  expect((await ui.find({ type: 'Text', text: /al día/ }))?.text).toBe('Todo está al día')
  expect(s.closed).toBe(1)
  expect(s.opened.length).toBe(1)
  expect(s.opened[0]?.focus).toBe(true)
  await ui.unmount()
})

const rowsOf = async (ui: { findAll: (q: { type: string }) => Promise<{ props: Record<string, unknown>; children: unknown[] }[]> }) =>
  (await ui.findAll({ type: 'Box' })).filter(b => b.props.flexDirection === 'row' && b.children.filter(c => (c as { type?: string }).type === 'Button').length > 1)

test('every screen draws its primary control; buttons side by side keep a gap and wrap whole', async ($, on) => {
  const tree = { name: 'tree', mode: 'import', title: 't', rows: [{ id: 'skill:a', kind: 'skill', label: 'a', status: 'modified', checked: true }], checked: [], open: ['\u001fskill'], hidden: 0, import: { profile: 'casa', projects: [], conflicts: {}, deletes: {} } }
  const screens = [
    { name: 'setup', tools: { git: true, gh: true, ghAuthed: true, login: 'Jorditomasg' } },
    { name: 'setup', tools: { git: true, gh: true, ghAuthed: false } },
    tree,
    { name: 'ask', kind: 'delete', queue: [{ id: 'a', label: 'a' }, { id: 'b', label: 'b' }], tree },
    { name: 'upload-first', profile: 'casa', pending: 2 },
    { name: 'conflict', tree, queue: [{ id: 'skill:a', label: 'a' }], diff: { fields: [] } },
    { name: 'review', tree, lines: [] },
    { name: 'summary', lines: ['x'], canUndo: true }
  ]
  const single = [
    { name: 'secrets', tree: { ...tree, upload: { profile: 'casa', answers: {}, exceptions: [], findings: [{ itemId: 'skill:a', file: 'SKILL.md', line: 1, preview: 'ghp_…', hash: 'h' }] } }, itemId: 'skill:a' },
    { name: 'menu' }, { name: 'busy' }, { name: 'error', text: 'x' }, { name: 'mix-name' }, { name: 'diff', tree, title: 'a', diff: { fields: [] } },
    { name: 'profiles', list: ['casa'], purpose: 'switch' }, { name: 'history', profile: 'casa', versions: [] }, { name: 'values', tree, asked: [{ name: 'n', label: 'n' }] },
    { name: 'setup', tools: { git: true, gh: true, ghAuthed: false, tokenVar: 'GH_TOKEN' } }
  ]
  const seeds: Record<string, unknown> = {}
  engine(on, seeds)
  for (const value of [...screens, ...single]) {
    Object.assign(seeds, screen(value))
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    const primary = await ui.find({ key: primaryKey(value as never, strings.es) })
    expect(['Button', 'Input', 'Select'].includes(primary?.type ?? '')).toBe(true)
    const rows = await rowsOf(ui)
    expect(rows.length > 0 || single.includes(value as never)).toBe(true)
    for (const row of rows) {
      expect(row.props.flexWrap).toBe('wrap')
      expect(Number(row.props.columnGap) >= 1).toBe(true)
      expect(row.children.some(c => (c as { text?: string }).text === ' ')).toBe(false)
    }
    await ui.unmount()
  }
})

test('a token in Claude\'s environment that overrides the GitHub login is explained', async ($, on) => {
  engine(on, screen({ name: 'setup', tools: { git: true, gh: true, ghAuthed: false, tokenVar: 'GITHUB_TOKEN' } }), [], { state: undefined })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /GITHUB_TOKEN/ }))?.text).toBe('✗ gh está usando GITHUB_TOKEN del entorno de Claude en lugar de tu sesión de gh auth login, y ese token no funciona.')
  expect((await ui.find({ type: 'Text', text: /settings\.json/ }))?.text.includes('Quita GITHUB_TOKEN de "env" en ~/.claude/settings.json')).toBe(true)
  expect(await ui.find({ key: 'signin' })).toBe(undefined)
  expect(await ui.find({ type: 'Text', text: /sin sesión/ })).toBe(undefined)
  await ui.unmount()
})
