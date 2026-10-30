import { expect, test } from 'claude-code/testing'
import { exceptionHash, fillMarkers, marker, sanitizeValue, scanFiles } from '../hooks/secrets'

const GH = 'ghp_' + 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8'
const PEM = '-----BEGIN OPENSSH ' + 'PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA\n-----END OPENSSH ' + 'PRIVATE KEY-----'

test('values under sensitive names become markers, others stay', () => {
  const { value, secrets } = sanitizeValue({ env: { GITHUB_TOKEN: 'abc', EDITOR: 'vim', API_KEY: 'k', MONKEY: 'banana' } }, 'setting:env')
  expect(value).toEqual({ env: { GITHUB_TOKEN: marker('setting:env.env.GITHUB_TOKEN'), EDITOR: 'vim', API_KEY: marker('setting:env.env.API_KEY'), MONKEY: 'banana' } })
  expect(secrets).toEqual(['setting:env.env.GITHUB_TOKEN', 'setting:env.env.API_KEY'])
})

test('tokens in MCP arguments and headers never stay', () => {
  const server = { command: 'npx', args: ['-y', 'srv', '--token', 'plain-value', '--api-key=xyz', GH], headers: { Authorization: 'Bearer abc' } }
  const { value } = sanitizeValue(server, 'mcp:gh')
  const text = JSON.stringify(value)
  expect(text.includes(GH)).toBe(false)
  expect(text.includes('plain-value')).toBe(false)
  expect(text.includes('xyz')).toBe(false)
  expect(text.includes('Bearer abc')).toBe(false)
  expect((value as { args: string[] }).args.slice(0, 3)).toEqual(['-y', 'srv', '--token'])
})

test('a token inside a command is replaced, the command kept', () => {
  const { value } = sanitizeValue({ hook: { command: `curl -H "x: ${GH}" https://a` } }, 'hook:x')
  expect(value).toEqual({ hook: { command: `curl -H "x: ${marker('hook:x.hook.command')}" https://a` } })
})

test('a token in free text blocks the item and says where', async () => {
  const files = { 'notes.md': `line one\nmy token ${GH} here\n` }
  const found = await scanFiles('p:x:memory:notes.md', files, new Set())
  expect(found.length).toBe(1)
  expect(found[0]).toMatchObject({ file: 'notes.md', line: 2 })
  expect(found[0]?.preview.includes(GH)).toBe(false)
  expect(found[0]?.preview.length).toBeLessThan(12)
})

test('an exception holds for that exact text in that item only', async () => {
  const files = { 'notes.md': `a ${GH}` }
  const hash = await exceptionHash('p:x:memory:notes.md', GH)
  expect((await scanFiles('p:x:memory:notes.md', files, new Set([hash]))).length).toBe(0)
  expect((await scanFiles('p:x:memory:other.md', files, new Set([hash]))).length).toBe(1)
  const changed = { 'notes.md': `a ${GH.slice(0, -1)}Z` }
  expect((await scanFiles('p:x:memory:notes.md', changed, new Set([hash]))).length).toBe(1)
})

test('a private key in a skill is found', async () => {
  const found = await scanFiles('skill:k', { 'SKILL.md': `key:\n${PEM}\n` }, new Set())
  expect(found.length).toBe(1)
  expect(found[0]?.preview.includes('b3BlbnNz')).toBe(false)
})

test('markers take the value this machine already has, or the one given', () => {
  const pushed = sanitizeValue({ env: { GITHUB_TOKEN: 'remote' }, args: ['--token', 'r2'] }, 'mcp:a').value
  const keep = fillMarkers(pushed, 'mcp:a', { env: { GITHUB_TOKEN: 'mine' }, args: ['--token', 'm2'] }, {})
  expect(keep).toEqual({ value: { env: { GITHUB_TOKEN: 'mine' }, args: ['--token', 'm2'] }, missing: [] })
  const asked = fillMarkers(pushed, 'mcp:a', undefined, { 'mcp:a.env.GITHUB_TOKEN': 'given' })
  expect(asked.missing).toEqual(['mcp:a.args.1'])
  expect((asked.value as { env: { GITHUB_TOKEN: string } }).env.GITHUB_TOKEN).toBe('given')
})
