import { expect, test } from 'claude-code/testing'
import * as app from '../hooks/app'
import { detectEnv } from '../hooks/platform'
import { emptyState, type SyncState } from '../hooks/profile'
import { ensureRepo } from '../hooks/repo'
import { fakeHost, unameLinux, type Command } from './fake-host'
import { claudeCommand, ghCommand, gitCommand, newRemote, type Remote } from './fake-git'
import { C, GH, H, LEAKS, machineA, PEM, SECRETS } from './fixture'

const CONFIG_KEY = { 'plugin:tool@market.config.options.apiKey': 'cfg' }
const APP = { root: `${H}/work/app`, url: 'git@github.com:U/app.git', tracked: ['CLAUDE.md'] }

async function machine (remote: Remote, files: Record<string, string>, extra: Command[] = []) {
  const host = fakeHost({ env: { HOME: H }, files, commands: [unameLinux, gitCommand(remote, APP), ghCommand(remote), ...extra] })
  const env = await detectEnv(host)
  const box: { state: SyncState } = { state: emptyState() }
  const ctx: app.Ctx = { host, env, cwd: APP.root, get state () { return box.state }, save: async s => { box.state = s } }
  await ensureRepo(host, env, 'me')
  box.state = { ...box.state, repo: 'me/claude-sync-config' }
  return { host, env, ctx, box }
}

const pushed = (remote: Remote) => remote.commits.flatMap(c => [c.message, ...c.tree.values()]).join('\n')

async function uploadAll (ctx: app.Ctx, profile = 'casa', exceptions: string[] = []) {
  const prep = await app.prepareUpload(ctx, profile, true)
  return { prep, summary: await app.upload(ctx, profile, new Set(prep.rows.filter(r => r.checked).map(r => r.id)), {}, exceptions) }
}

test('no secret ever reaches the repo: markers for config, blocks for free text', async () => {
  const remote = newRemote()
  const a = await machine(remote, machineA())
  const { prep, summary } = await uploadAll(a.ctx)
  expect(prep.findings.map(f => f.itemId).sort()).toEqual(['p:github.com/U/app:memory:a.md', 'skill:keys'])
  expect(prep.rows.find(r => r.id === 'skill:keys')?.status).toBe('secret')
  expect(summary.applied.includes('mcp:github')).toBe(true)
  expect(summary.applied.includes('skill:keys')).toBe(false)
  const all = pushed(remote)
  for (const secret of [...SECRETS, 'plain-config-secret']) expect(all.includes(secret)).toBe(false)
  for (const leak of LEAKS) expect(all.includes(leak)).toBe(false)
  expect(all.includes('${secret:mcp:github.env.GITHUB_PERSONAL_ACCESS_TOKEN}')).toBe(true)
  expect(all.includes('${secret:setting:env.GITHUB_TOKEN}')).toBe(true)
  expect(all.includes('/home/u')).toBe(false)
})

test('a text marked "not a secret" goes up as it is, only there, and only its hash is kept', async () => {
  const remote = newRemote()
  const a = await machine(remote, machineA())
  const first = await app.prepareUpload(a.ctx, 'casa', true)
  const finding = first.findings.find(f => f.itemId.endsWith('memory:a.md'))
  expect(finding).toBeDefined()
  await app.upload(a.ctx, 'casa', new Set([...first.rows.filter(r => r.checked).map(r => r.id), 'p:github.com/U/app:memory:a.md']), {}, [finding?.hash ?? ''])
  const last = remote.commits.at(-1)
  const holders = [...(last?.tree ?? [])].filter(([, text]) => text.includes(GH)).map(([path]) => path)
  expect(holders).toEqual(['profiles/casa/projects/github.com_2fU_2fapp/memory/a.md/a.md'])
  expect(last?.tree.get('exceptions.json')).toBe(JSON.stringify({ hashes: [finding?.hash] }, null, 2) + '\n')
  expect(pushed(remote).includes(PEM)).toBe(false)
  expect(a.box.state.exceptions).toEqual([finding?.hash ?? ''])
})

test('the second machine merges, keeps its own keys and its own secret values', async () => {
  const remote = newRemote()
  const a = await machine(remote, machineA())
  await uploadAll(a.ctx)
  const b = await machine(remote, {
    [`${C}/settings.json`]: JSON.stringify({ model: 'sonnet', theme: 'dark', env: { GITHUB_TOKEN: 'b-own-token' } }),
    [`${H}/.claude.json`]: JSON.stringify({ userID: 'b-user', projects: {} })
  }, [claudeCommand()])
  b.box.state = { ...b.box.state, profile: 'casa' }
  const prep = await app.prepareImport(b.ctx, 'casa')
  expect(prep.rows.find(r => r.id === 'setting:model')?.status).toBe('conflict')
  expect(prep.rows.find(r => r.id.startsWith('hook:Stop:'))?.status).toBe('other-os')
  expect(prep.rows.find(r => r.id === 'setting:env')?.status).toBe('conflict')
  const selected = new Set([...prep.rows.filter(r => r.checked).map(r => r.id), 'setting:env'])
  const asked = await app.missingSecrets(b.ctx, prep, selected)
  expect(asked.map(a => a.name).sort()).toEqual(['mcp:github.args.3', 'mcp:github.env.GITHUB_PERSONAL_ACCESS_TOKEN', 'plugin:tool@market#option:apiKey', 'plugin:tool@market.config.options.apiKey'])
  const summary = await app.importItems(b.ctx, prep, { selected, conflicts: { 'setting:model': 'local', 'setting:env': 'remote' }, values: { ...CONFIG_KEY, 'mcp:github.args.3': 'b-arg', 'mcp:github.env.GITHUB_PERSONAL_ACCESS_TOKEN': 'b-mcp', 'plugin:tool@market#option:apiKey': 'k' } })
  expect(summary.skipped).toEqual([])
  const settings = JSON.parse(b.host.files.get(`${C}/settings.json`) ?? '{}')
  expect(settings.model).toBe('sonnet')
  expect(settings.theme).toBe('dark')
  expect(settings.env).toEqual({ GITHUB_TOKEN: 'b-own-token', EDITOR: 'vim' })
  expect(settings.hooks.PreToolUse[0].hooks[0].command).toBe('python3 /home/u/.claude/hooks/guard.py')
  expect(settings.hooks.Stop).toBe(undefined)
  expect(settings.permissions).toEqual({ allow: ['Bash(git status)'], deny: ['Read(.env)'], defaultMode: 'acceptEdits' })
  expect(b.host.files.get(`${C}/hooks/guard.py`)).toBe('print("guard")\n')
  const claudeJson = JSON.parse(b.host.files.get(`${H}/.claude.json`) ?? '{}')
  expect(claudeJson.userID).toBe('b-user')
  expect(claudeJson.mcpServers.github.env.GITHUB_PERSONAL_ACCESS_TOKEN).toBe('b-mcp')
  expect(claudeJson.mcpServers.github.args[3]).toBe('b-arg')
  expect(claudeJson.projects['/home/u/work/app'].allowedTools).toEqual(['Bash(ls)'])
  const ran = b.host.ran.map(r => r.argv.join(' '))
  expect(ran.includes('claude plugin marketplace add o/market')).toBe(true)
  expect(ran.includes('claude plugin install tool@market --scope user')).toBe(true)
  const configure = b.host.ran.find(r => r.argv.includes('configure'))
  expect(configure?.options.stdin).toBe('{"apiKey":"k"}')
  expect(summary.restart).toBe(true)
  expect((await app.status(b.ctx)).pending).toBe(1)
})

test('a secret nobody gave skips only that item', async () => {
  const remote = newRemote()
  const a = await machine(remote, machineA())
  await uploadAll(a.ctx)
  const b = await machine(remote, {}, [claudeCommand()])
  const prep = await app.prepareImport(b.ctx, 'casa')
  const summary = await app.importItems(b.ctx, prep, { selected: new Set(['mcp:github', 'claude-md']) })
  expect(summary.applied).toEqual(['claude-md'])
  expect(summary.skipped[0]?.id).toBe('mcp:github')
  expect(summary.skipped[0]?.reason.startsWith('missing secret')).toBe(true)
  expect(b.host.files.get(`${H}/.claude.json`)).toBe(undefined)
})

test('an unreadable settings.json is never touched; the rest still applies', async () => {
  const remote = newRemote()
  const a = await machine(remote, machineA())
  await uploadAll(a.ctx)
  const b = await machine(remote, { [`${C}/settings.json`]: '{ "model": ' }, [claudeCommand()])
  const prep = await app.prepareImport(b.ctx, 'casa')
  const summary = await app.importItems(b.ctx, prep, { selected: new Set(['setting:model', 'claude-md', 'agent:reviewer.md']) })
  expect(b.host.files.get(`${C}/settings.json`)).toBe('{ "model": ')
  expect(summary.skipped.map(s => s.id)).toEqual(['setting:model'])
  expect(summary.applied.sort()).toEqual(['agent:reviewer.md', 'claude-md'])
})

test('a plugin that cannot be installed is skipped with the reason', async () => {
  const remote = newRemote()
  const a = await machine(remote, machineA())
  await uploadAll(a.ctx)
  const b = await machine(remote, {}, [claudeCommand({ failInstall: ['tool@market'] })])
  const prep = await app.prepareImport(b.ctx, 'casa')
  const summary = await app.importItems(b.ctx, prep, { selected: new Set(['plugin:tool@market', 'claude-md']), values: CONFIG_KEY })
  expect(summary.skipped).toEqual([{ id: 'plugin:tool@market', reason: 'install failed: plugin not found in marketplace' }])
  expect(summary.applied.includes('claude-md')).toBe(true)
  expect(summary.applied.includes('marketplace:market')).toBe(true)
})

test('a newer plugin version installs with a warning', async () => {
  const remote = newRemote()
  const a = await machine(remote, machineA())
  await uploadAll(a.ctx)
  const b = await machine(remote, {}, [claudeCommand({ version: '2.0.0' })])
  const prep = await app.prepareImport(b.ctx, 'casa')
  const summary = await app.importItems(b.ctx, prep, { selected: new Set(['plugin:tool@market']), values: CONFIG_KEY })
  expect(summary.warnings).toEqual(['tool@market: 1.2.0 → 2.0.0'])
})

test('undo puts back the files and uninstalls what the import installed', async () => {
  const remote = newRemote()
  const a = await machine(remote, machineA())
  await uploadAll(a.ctx)
  const original = JSON.stringify({ model: 'sonnet' })
  const b = await machine(remote, { [`${C}/settings.json`]: original, [`${C}/skills/writer/old.md`]: 'old' }, [claudeCommand()])
  const prep = await app.prepareImport(b.ctx, 'casa')
  await app.importItems(b.ctx, prep, { selected: new Set(['setting:statusLine', 'plugin:tool@market', 'skill:writer']), conflicts: { 'skill:writer': 'remote' }, values: CONFIG_KEY })
  expect(b.host.files.has(`${C}/skills/writer/old.md`)).toBe(false)
  expect(await app.undo(b.ctx)).toBe(true)
  expect(JSON.parse(b.host.files.get(`${C}/settings.json`) ?? '')).toEqual(JSON.parse(original))
  expect(b.host.files.get(`${C}/skills/writer/old.md`)).toBe('old')
  expect(b.host.files.has(`${C}/skills/writer/SKILL.md`)).toBe(false)
  expect(b.host.files.has(`${C}/statusline.sh`)).toBe(false)
  expect(b.host.ran.some(r => r.argv.join(' ') === 'claude plugin uninstall tool@market')).toBe(true)
  expect(await app.undo(b.ctx)).toBe(false)
})

test('local items the profile lacks are deleted only when the person says so', async () => {
  const remote = newRemote()
  const a = await machine(remote, machineA())
  await uploadAll(a.ctx)
  const b = await machine(remote, { [`${C}/agents/mine.md`]: 'm', [`${C}/agents/keep.md`]: 'k' }, [claudeCommand()])
  const prep = await app.prepareImport(b.ctx, 'casa')
  await app.importItems(b.ctx, prep, { selected: new Set(['agent:reviewer.md']), deletes: { 'agent:mine.md': 'delete' } })
  expect(b.host.files.has(`${C}/agents/mine.md`)).toBe(false)
  expect(b.host.files.get(`${C}/agents/keep.md`)).toBe('k')
  expect(b.host.files.has(`${C}/agents/reviewer.md`)).toBe(true)
})

test('upload asks before removing a deleted item from the profile', async () => {
  const remote = newRemote()
  const a = await machine(remote, machineA())
  await uploadAll(a.ctx)
  a.host.files.delete(`${C}/agents/reviewer.md`)
  const prep = await app.prepareUpload(a.ctx, 'casa')
  expect(prep.rows.find(r => r.id === 'agent:reviewer.md')?.status).toBe('missing-local')
  await app.upload(a.ctx, 'casa', new Set(['agent:reviewer.md']), { 'agent:reviewer.md': 'keep' })
  expect(remote.commits.at(-1)?.tree.has('profiles/casa/global/agent/reviewer.md/reviewer.md')).toBe(true)
  await app.upload(a.ctx, 'casa', new Set(['agent:reviewer.md']), { 'agent:reviewer.md': 'remove' })
  expect(remote.commits.at(-1)?.tree.has('profiles/casa/global/agent/reviewer.md/reviewer.md')).toBe(false)
})

test('status: ● counts local changes in the profile, ↓ says the repo moved', async () => {
  const remote = newRemote()
  const a = await machine(remote, machineA())
  await uploadAll(a.ctx)
  expect(await app.status(a.ctx)).toEqual({ isReady: true, profile: 'casa', pending: 0, incoming: false })
  a.host.files.set(`${C}/CLAUDE.md`, 'changed\n')
  a.host.files.set(`${C}/agents/brand-new.md`, 'x')
  expect((await app.status(a.ctx)).pending).toBe(1)
  const b = await machine(remote, {}, [claudeCommand()])
  b.box.state = { ...b.box.state, profile: 'casa' }
  const prep = await app.prepareImport(b.ctx, 'casa')
  await app.importItems(b.ctx, prep, { selected: new Set(['claude-md']) })
  b.host.files.set(`${C}/CLAUDE.md`, 'from b\n')
  await app.upload(b.ctx, 'casa', new Set(['claude-md']))
  expect((await app.status(a.ctx)).incoming).toBe(true)
})

test('history lists versions and an old one can be applied', async () => {
  const remote = newRemote()
  const a = await machine(remote, machineA())
  await uploadAll(a.ctx)
  a.host.files.set(`${C}/CLAUDE.md`, 'v2\n')
  await app.upload(a.ctx, 'casa', new Set(['claude-md']))
  const list = await app.versions(a.ctx, 'casa')
  expect(list.map(v => v.commit)).toEqual(['c2', 'c1'])
  const prep = await app.prepareImport(a.ctx, 'casa', 'c1')
  expect(prep.rows.find(r => r.id === 'claude-md')?.status).toBe('remote-changed')
  expect((await app.diffFor(a.ctx, prep, 'claude-md')).text?.includes('-v2')).toBe(true)
  await app.importItems(a.ctx, prep, { selected: new Set(['claude-md']) })
  expect(a.host.files.get(`${C}/CLAUDE.md`)).toBe('# Rules\nUse ~/bin when needed.\n')
})

test('a mixed profile copies pieces of others', async () => {
  const remote = newRemote()
  const a = await machine(remote, machineA())
  await uploadAll(a.ctx, 'casa')
  await app.upload(a.ctx, 'trabajo', new Set(['agent:reviewer.md']))
  await app.createMix(a.ctx, 'todo', [{ profile: 'casa', id: 'claude-md' }, { profile: 'trabajo', id: 'agent:reviewer.md' }])
  const t = remote.commits.at(-1)?.tree
  expect(JSON.parse(t?.get('profiles/todo/manifest.json') ?? '{}').items['claude-md'].hash).toBeDefined()
  expect(t?.get('profiles/todo/global/agent/reviewer.md/reviewer.md')).toBe('# reviewer\n')
  expect(await app.listProfiles(a.ctx)).toEqual(['casa', 'todo', 'trabajo'])
})

test('undo only puts back what the apply changed, never what Claude wrote since', async () => {
  const remote = newRemote()
  const a = await machine(remote, machineA())
  await uploadAll(a.ctx)
  const b = await machine(remote, { [`${H}/.claude.json`]: JSON.stringify({ numStartups: 1, mcpServers: { mine: { command: 'x' } } }) }, [claudeCommand()])
  const prep = await app.prepareImport(b.ctx, 'casa')
  await app.importItems(b.ctx, prep, { selected: new Set(['mcp:github']), values: { 'mcp:github.args.3': 'v', 'mcp:github.env.GITHUB_PERSONAL_ACCESS_TOKEN': 'w' } })
  const during = JSON.parse(b.host.files.get(`${H}/.claude.json`) ?? '{}')
  b.host.files.set(`${H}/.claude.json`, JSON.stringify({ ...during, numStartups: 7, tipsHistory: { a: 1 } }))
  expect(b.host.files.get(`${C}/plugins/data/config-sync-claude-sync/backup.json`)?.includes('"w"')).toBe(false)
  await app.undo(b.ctx)
  expect(JSON.parse(b.host.files.get(`${H}/.claude.json`) ?? '{}')).toEqual({ numStartups: 7, tipsHistory: { a: 1 }, mcpServers: { mine: { command: 'x' } } })
})

test('a token inside a permission rule never shows in ids, labels or commit messages', async () => {
  const remote = newRemote()
  const files = machineA()
  files[`${C}/settings.json`] = JSON.stringify({ permissions: { allow: [`Bash(curl -H "x: ${GH}")`] } })
  const a = await machine(remote, files)
  const { summary } = await uploadAll(a.ctx)
  expect(summary.applied.some(id => id.startsWith('permission:allow:'))).toBe(true)
  expect(pushed(remote).includes(GH)).toBe(false)
})
