import { expect, test } from 'claude-code/testing'
import { fieldDiff, itemDiff, lineDiff } from '../hooks/diff'
import { InvalidJson, mergeInto } from '../hooks/jsonmerge'

test('a changed line is a unified hunk with context', () => {
  const diff = lineDiff('a\nb\nc\n', 'a\nB\nc\n', 'CLAUDE.md')
  expect(diff).toBe('--- a/CLAUDE.md\n+++ b/CLAUDE.md\n@@ -1,3 +1,3 @@\n a\n-b\n+B\n c\n')
  expect(lineDiff('same\n', 'same\n', 'x')).toBe('')
  expect(lineDiff('', 'new\n', 'x')).toBe('--- a/x\n+++ b/x\n@@ -0,0 +1,1 @@\n+new\n')
})

test('far apart changes are separate hunks', () => {
  const a = Array.from({ length: 20 }, (_, i) => `l${i}`).join('\n')
  const b = a.replace('l1\n', 'L1\n').replace('l18', 'L18')
  expect(lineDiff(a, b, 'f').match(/^@@/gm)?.length).toBe(2)
})

test('settings differ field by field', () => {
  expect(fieldDiff({ a: 1, b: { c: 2 } }, { b: { c: 3 }, d: 4 })).toEqual([
    { path: 'a', op: '-', before: 1 },
    { path: 'b.c', op: '~', before: 2, after: 3 },
    { path: 'd', op: '+', after: 4 }
  ])
  expect(itemDiff({ files: { 'a.md': 'x\n' } }, { files: { 'a.md': 'y\n' } }).text?.includes('-x\n+y')).toBe(true)
})

test('merging keeps every key it does not touch', () => {
  const before = JSON.stringify({ model: 'opus', permissions: { allow: ['A'] }, other: { deep: true } })
  const after = JSON.parse(mergeInto(before, [{ list: ['permissions', 'allow'], entry: 'B' }, { path: ['env'], value: { X: '1' } }]))
  expect(after).toEqual({ model: 'opus', permissions: { allow: ['A', 'B'] }, other: { deep: true }, env: { X: '1' } })
})

test('a hook is added once into its group and removed alone', () => {
  const hook = { event: 'PreToolUse', matcher: 'Bash', hook: { type: 'command', command: 'g' } }
  const start = JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'other' }] }] } })
  const twice = mergeInto(mergeInto(start, [{ hook }]), [{ hook }])
  expect(JSON.parse(twice).hooks.PreToolUse).toEqual([{ matcher: 'Bash', hooks: [{ type: 'command', command: 'other' }, { type: 'command', command: 'g' }] }])
  const removed = JSON.parse(mergeInto(twice, [{ hook, remove: true }]))
  expect(removed.hooks.PreToolUse).toEqual([{ matcher: 'Bash', hooks: [{ type: 'command', command: 'other' }] }])
  const empty = JSON.parse(mergeInto(JSON.stringify({ model: 'x' }), [{ hook }, { hook, remove: true }]))
  expect(empty).toEqual({ model: 'x' })
})

test('removing a key prunes only the objects it emptied', () => {
  const out = JSON.parse(mergeInto(JSON.stringify({ a: { b: { c: 1 } }, k: 1 }), [{ path: ['a', 'b', 'c'], remove: true }]))
  expect(out).toEqual({ k: 1 })
})

test('an invalid file is refused, never overwritten', () => {
  expect(() => mergeInto('{ nope', [{ path: ['a'], value: 1 }], 'settings.json')).toThrow(InvalidJson)
  expect(mergeInto(undefined, [{ path: ['a'], value: 1 }])).toBe('{\n  "a": 1\n}\n')
})
