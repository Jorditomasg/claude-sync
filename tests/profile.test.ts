import { expect, test } from 'claude-code/testing'
import type { Item } from '../hooks/inventory'
import { emptyManifest, importRows, type Row, mix, pendingCount, planImport, planUpload, storagePath, uploadRows, withRequired, type Manifest, type ManifestItem } from '../hooks/profile'

const item = (id: string, kind: Item['kind'] = 'skill', extra: Partial<Item> = {}): Item => ({ id, kind, key: id.split(':').pop() ?? id, label: id, content: { files: {} }, ...extra })
const entry = (hash: string, extra: Partial<ManifestItem> = {}): ManifestItem => ({ kind: 'skill', key: 'k', label: 'k', hash, os: 'linux', updatedAt: '', path: 'global/skill/k', ...extra })
const manifest = (items: Record<string, ManifestItem>): Manifest => ({ ...emptyManifest('casa'), items })
const status = (rows: { id: string; status: string }[], id: string) => rows.find(r => r.id === id)?.status

test('upload statuses follow local and remote hashes since the last sync', () => {
  const local = [item('skill:same'), item('skill:edited'), item('skill:fresh'), item('skill:theirs'), item('skill:both')]
  const hashes = { 'skill:same': 'h1', 'skill:edited': 'h2-local', 'skill:fresh': 'n', 'skill:theirs': 'h4', 'skill:both': 'x-local' }
  const m = manifest({ 'skill:same': entry('h1'), 'skill:edited': entry('h2'), 'skill:theirs': entry('h4-remote'), 'skill:both': entry('x-remote'), 'skill:gone': entry('g') })
  const state = { synced: { 'skill:same': 'h1', 'skill:edited': 'h2', 'skill:theirs': 'h4', 'skill:both': 'x', 'skill:gone': 'g' } }
  const rows = uploadRows(local, hashes, m, state, 'linux')
  expect(status(rows, 'skill:same')).toBe('same')
  expect(status(rows, 'skill:edited')).toBe('modified')
  expect(status(rows, 'skill:fresh')).toBe('not-in-profile')
  expect(rows.find(r => r.id === 'skill:fresh')?.checked).toBe(false)
  expect(status(rows, 'skill:theirs')).toBe('remote-changed')
  expect(status(rows, 'skill:both')).toBe('conflict')
  expect(status(rows, 'skill:gone')).toBe('missing-local')
  expect(pendingCount(rows, state)).toBe(3)
  expect(pendingCount(rows, { synced: {} })).toBe(0)
})

test('an item of another system is never offered for removal', () => {
  const m = manifest({ 'hook:win': entry('w', { kind: 'hook', os: 'windows', hints: ['windows'] }) })
  const rows = uploadRows([], {}, m, { synced: { 'hook:win': 'w' } }, 'macos')
  expect(rows).toEqual([])
  expect(planUpload(rows, new Set(['hook:win'])).askRemove).toEqual([])
  expect(pendingCount(rows, { synced: { 'hook:win': 'w' } })).toBe(0)
})

test('a profile item never present here is not a deletion', () => {
  const rows = uploadRows([], {}, manifest({ 'skill:x': entry('x') }), { synced: {} }, 'linux')
  expect(rows).toEqual([])
})

test('upload: removal of deleted items is asked, the rest is put', () => {
  const rows = uploadRows([item('skill:a')], { 'skill:a': 'a2' }, manifest({ 'skill:a': entry('a'), 'skill:b': entry('b') }), { synced: { 'skill:a': 'a', 'skill:b': 'b' } }, 'linux')
  expect(planUpload(rows, new Set(['skill:a', 'skill:b']))).toEqual({ put: ['skill:a'], askRemove: ['skill:b'] })
  expect(planUpload(rows, new Set(['skill:a']))).toEqual({ put: ['skill:a'], askRemove: [] })
})

test('import statuses and the deletion question', () => {
  const m = manifest({
    'skill:new': entry('n'), 'skill:upd': entry('u2'), 'skill:mine': entry('m'), 'skill:win': entry('w', { os: 'windows', hints: ['windows'], kind: 'hook' }),
    'agent:a': entry('a', { kind: 'agent' })
  })
  const local = [item('skill:upd'), item('skill:mine'), item('skill:extra'), item('agent:a', 'agent'), item('agent:other', 'agent'), item('command:c', 'command')]
  const rows = importRows(m, local, { 'skill:upd': 'u1', 'skill:mine': 'm-local', 'agent:a': 'a' }, { synced: { 'skill:upd': 'u1', 'skill:mine': 'm' } }, 'linux')
  expect(status(rows, 'skill:new')).toBe('new')
  expect(status(rows, 'skill:upd')).toBe('remote-changed')
  expect(status(rows, 'skill:mine')).toBe('modified')
  expect(status(rows, 'skill:win')).toBe('other-os')
  expect(status(rows, 'agent:a')).toBe('same')
  const plan = planImport(rows, new Set(['skill:new', 'skill:upd', 'skill:win']), local)
  expect(plan.put).toEqual(['skill:new', 'skill:upd'])
  expect(plan.askDelete).toEqual(['skill:extra'])
})

test('selected hooks drag the scripts they need', () => {
  const rows = [
    { id: 'other', kind: 'skill', label: '', status: 'same', checked: false },
    { id: 'hook:a', kind: 'hook', label: '', status: 'modified', checked: true, requires: ['script:hooks/a.py'] },
    { id: 'script:hooks/a.py', kind: 'script', label: '', status: 'not-in-profile', checked: false }
  ] satisfies Row[]
  expect([...withRequired(rows, new Set(['hook:a']))].sort()).toEqual(['hook:a', 'script:hooks/a.py'])
})

test('a mixed profile is a copy', () => {
  const work = manifest({ 'skill:a': entry('a', { path: 'global/skill/a' }), 'skill:b': entry('b') })
  const home = manifest({ 'agent:c': entry('c', { kind: 'agent', path: 'global/agent/c.md' }) })
  const out = mix([{ profile: 'work', manifest: work }, { profile: 'home', manifest: home }], [{ profile: 'work', id: 'skill:a' }, { profile: 'home', id: 'agent:c' }], 'both')
  expect(Object.keys(out.items)).toEqual(['skill:a', 'agent:c'])
  expect(out.profile).toBe('both')
  ;(work.items['skill:a'] as ManifestItem).hash = 'changed'
  expect(out.items['skill:a']?.hash).toBe('a')
})

test('storage paths are stable and safe', () => {
  expect(storagePath({ kind: 'permission', key: 'allow:Bash(git status)' })).toBe('global/permission/allow_3aBash_28git_20status_29.json')
  expect(storagePath({ kind: 'memory', key: 'a.md', project: 'github.com/U/app' })).toBe('projects/github.com_2fU_2fapp/memory/a.md')
})
