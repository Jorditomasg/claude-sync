import type { On } from 'claude-code'
import { expect, test } from 'claude-code/testing'

const MODE = { plugin: 'config-sync', component: 'SessionMode', requestId: 'mode', props: { modes: [] } } as const
const PANE = { plugin: 'config-sync', component: 'Pane', requestId: 'config-sync', props: { title: 'Claude Sync', isFocused: true, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} } } as const
const STATE = { repo: 'me/claude-sync-config', profile: 'casa', profiles: {}, exceptions: [] }
const ENV: Record<string, string> = { LANG: 'es_ES.UTF-8', HOME: '/home/u' }

const CHIP = { shape: 'chip-1', value: { isReady: true, profile: 'casa', pending: 3, incoming: true } }

function engine (on: On, seeds: Record<string, unknown> = {}, opened: unknown[] = []) {
  on('state.get', async (_, e, next) => {
    const read = await next(e)
    const seed = seeds[e.key]
    const isUnset = 'value' in read && (read.value?.version ?? 0) === 0
    return seed !== undefined && isUnset ? ({ value: { value: seed, version: 0 } } as typeof read) : read
  })
  on('env.get', (_, e) => ({ value: ENV[e.name] }))
  on('settings.read', () => ({ value: {} }))
  on('process.run', (_, e) => ({ value: { exitCode: e.argv[0] === 'uname' ? 0 : 1, stdout: e.argv[0] === 'uname' ? 'Linux\n' : '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('store.get', (_, e) => ({ value: e.key === 'state' ? STATE : undefined }))
  on('session.cwd', () => ({ value: '/home/u' }))
  on('fs.exists', () => ({ value: false }))
  on('fs.list', () => ({ value: [] }))
  on('ui.open', (_, e) => { opened.push(e); return { value: { isPlaced: true } } })
  on('ui.render', ($, e) => { const { Text } = $.ui.resolve(e); return <Text>⏵⏵ bypass permissions on</Text> })
}

test('the footer chip shows the profile and its marks, and opens the menu', async ($, on) => {
  const opened: { focus?: boolean }[] = []
  engine(on, { chip: CHIP }, opened)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...MODE, surface })
    expect((await ui.find({ key: 'config-sync-chip' }))?.text).toBe('⇅ casa ●↓')
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
