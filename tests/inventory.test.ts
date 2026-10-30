import { expect, test } from 'claude-code/testing'
import { canonical } from '../hooks/hash'
import { applyJson, collectGlobal, collectProject, fileWrites, hashContent, valueEdits } from '../hooks/inventory'
import { detectEnv } from '../hooks/platform'
import { fakeHost, ok, unameLinux, type Command } from './fake-host'
import { C, H, LEAKS, machineA } from './fixture'

const git: Command = (argv, options) => {
  if (argv[0] !== 'git') return undefined
  if (argv[1] === 'remote') return ok('https://user:pw@github.com/U/app.git\n')
  if (argv[1] === 'ls-files' && options.cwd === `${H}/work/app`) return ok('CLAUDE.md\n.claude/settings.json\n')
  return undefined
}

async function setup (files = machineA()) {
  const host = fakeHost({ env: { HOME: H }, files, commands: [unameLinux, git] })
  return { host, env: await detectEnv(host) }
}

test('every global piece is an item, nothing from the never-sync list', async () => {
  const { host, env } = await setup()
  const { items, warnings } = await collectGlobal(host, env)
  expect(warnings).toEqual([])
  const ids = items.map(i => i.id).filter(id => !id.startsWith('hook:'))
  expect(ids.sort()).toEqual([
    'agent:reviewer.md', 'claude-md', 'command:git/ship.md', 'keybindings', 'marketplace:market', 'mcp:github',
    'permission:allow:Bash(git status)', 'permission:defaultMode', 'permission:deny:Read(.env)',
    'plugin-data:tool@market', 'plugin:tool@market', 'script:hooks/guard.py', 'script:statusline.sh',
    'setting:env', 'setting:model', 'setting:statusLine', 'skill:keys', 'skill:writer'
  ])
  expect(items.filter(i => i.kind === 'hook').length).toBe(2)
  const all = canonical(items)
  for (const leak of LEAKS) expect(all.includes(leak)).toBe(false)
})

test('paths go up as ~, hooks drag their scripts, other-system commands are tagged', async () => {
  const { host, env } = await setup()
  const { items } = await collectGlobal(host, env)
  const guard = items.find(i => i.id.startsWith('hook:PreToolUse:Bash:'))
  expect(guard?.content.value).toEqual({ event: 'PreToolUse', matcher: 'Bash', hook: { type: 'command', command: 'python3 ~/.claude/hooks/guard.py' } })
  expect(guard?.requires).toEqual(['script:hooks/guard.py'])
  expect(items.find(i => i.id.startsWith('hook:Stop'))?.hints).toEqual(['windows'])
  expect(items.find(i => i.id === 'setting:statusLine')?.requires).toEqual(['script:statusline.sh'])
  expect(items.find(i => i.id === 'claude-md')?.content.files?.['CLAUDE.md']).toBe('# Rules\nUse ~/bin when needed.\n')
  expect(Object.keys(items.find(i => i.id === 'skill:writer')?.content.files ?? {})).toEqual(['SKILL.md', 'ref/notes.md'])
})

test('a plugin carries version, state, config and which options are sensitive', async () => {
  const { host, env } = await setup()
  const { items } = await collectGlobal(host, env)
  const plugin = items.find(i => i.id === 'plugin:tool@market')
  expect(plugin?.content.value).toEqual({ enabled: true, version: '1.2.0', gitCommitSha: 'abc123', config: { options: { mode: 'fast', apiKey: 'plain-config-secret' } } })
  expect(plugin?.sensitiveOptions).toEqual(['apiKey'])
  expect(plugin?.requires).toEqual(['marketplace:market'])
  expect(Object.keys(items.find(i => i.id === 'plugin-data:tool@market')?.content.files ?? {})).toEqual(['data/tool-market/db.json', 'store/tool_market-1234.json'])
  expect(items.some(i => i.id.includes('claude-sync'))).toBe(false)
})

test('project items: identity by remote, config keys only, memory, tracked files marked', async () => {
  const { host, env } = await setup()
  const { items, project } = await collectProject(host, env, `${H}/work/app`)
  expect(project?.id).toBe('github.com/U/app')
  expect(items.map(i => i.id).sort()).toEqual([
    'p:github.com/U/app:agent:tester.md', 'p:github.com/U/app:config:allowedTools',
    'p:github.com/U/app:file:.claude/settings.json', 'p:github.com/U/app:file:.mcp.json', 'p:github.com/U/app:file:CLAUDE.md',
    'p:github.com/U/app:memory:MEMORY.md', 'p:github.com/U/app:memory:a.md'
  ])
  expect(canonical(items).includes('SESSION-ID-LEAK')).toBe(false)
  expect(items.find(i => i.id.endsWith('file:CLAUDE.md'))?.inProjectGit).toBe(true)
  expect(items.find(i => i.id.endsWith('agent:tester.md'))?.inProjectGit).toBe(undefined)
  expect(items.find(i => i.id.endsWith('file:CLAUDE.md'))?.content.files?.['CLAUDE.md']).toBe('# App\nRun ./run.sh\n')
})

test('skills Claude syncs from the account and dotfiles are never items', async () => {
  const files = machineA()
  files[`${C}/skills/synced/0f6e/built-in-browser/SKILL.md`] = 'browser\n'
  files[`${C}/skills/synced/.bucket-a1`] = 'x'
  files[`${C}/skills/synced/.last-complete-round`] = '3'
  files[`${C}/skills/.bucket-b2/SKILL.md`] = 'x'
  files[`${C}/agents/.bucket-c3.md`] = 'x'
  files[`${C}/commands/.cache/run.md`] = 'x'
  files[`${C}/projects/-home-u-work-app/memory/.bucket-d4`] = 'x'
  files[`${H}/work/app/.claude/skills/.bucket-e5/SKILL.md`] = 'x'
  const { host, env } = await setup(files)
  const global = (await collectGlobal(host, env)).items.map(i => i.id)
  expect(global.filter(id => id.startsWith('skill:')).sort()).toEqual(['skill:keys', 'skill:writer'])
  expect(global.filter(id => id.startsWith('agent:') || id.startsWith('command:')).sort()).toEqual(['agent:reviewer.md', 'command:git/ship.md'])
  const project = (await collectProject(host, env, `${H}/work/app`)).items.map(i => i.id)
  expect(project.some(id => id.includes('bucket'))).toBe(false)
  expect(canonical([global, project]).includes('synced')).toBe(false)
})

test('project config keys with an empty value are not items', async () => {
  const files = machineA()
  files[`${H}/.claude.json`] = JSON.stringify({
    projects: { '/home/u/work/app': { allowedTools: [], mcpServers: {}, enabledMcpjsonServers: [], disabledMcpjsonServers: ['x'], mcpContextUris: [], hasTrustDialogAccepted: true } }
  })
  const { host, env } = await setup(files)
  const config = (await collectProject(host, env, `${H}/work/app`)).items.filter(i => i.kind === 'project-config')
  expect(config.map(i => i.key)).toEqual(['disabledMcpjsonServers'])
  for (const value of [null, '', [], {}]) {
    files[`${H}/.claude.json`] = JSON.stringify({ projects: { '/home/u/work/app': { allowedTools: value } } })
    const again = await setup(files)
    expect((await collectProject(again.host, again.env, `${H}/work/app`)).items.some(i => i.kind === 'project-config')).toBe(false)
  }
})

test('writing every item into an empty machine gives back the same items', async () => {
  const a = await setup()
  const { items } = await collectGlobal(a.host, a.env)
  const b = await setup({ [`${C}/plugins/installed_plugins.json`]: a.host.files.get(`${C}/plugins/installed_plugins.json`) ?? '', [`${C}/plugins/cache/market/tool/1.2.0/.claude-plugin/plugin.json`]: a.host.files.get(`${C}/plugins/cache/market/tool/1.2.0/.claude-plugin/plugin.json`) ?? '', [`${C}/plugins/known_marketplaces.json`]: a.host.files.get(`${C}/plugins/known_marketplaces.json`) ?? '' })
  for (const item of items) {
    if (item.content.files) for (const w of fileWrites(item, item.content.files, b.env, {})) await b.host.write(w.path, w.text ?? '')
    else await applyJson(b.host, valueEdits(item, item.content.value, b.env, {}))
  }
  const again = await collectGlobal(b.host, b.env)
  const hashes = async (list: typeof items) => Object.fromEntries(await Promise.all(list.map(async i => [i.id, await hashContent(i.content)])))
  expect(await hashes(again.items)).toEqual(await hashes(items))
})

test('an unreadable settings.json is a warning, not a crash', async () => {
  const files = machineA()
  files[`${C}/settings.json`] = '{ broken'
  const { host, env } = await setup(files)
  const { items, warnings } = await collectGlobal(host, env)
  expect(warnings.length).toBe(1)
  expect(items.some(i => i.id === 'claude-md')).toBe(true)
})

test('on Windows paths go up as ~ with forward slashes and hooks find their scripts', async () => {
  const W = 'C:\\Users\\Ana'
  const host = fakeHost({
    env: { OS: 'Windows_NT', USERPROFILE: W },
    files: {
      [`${W}\\.claude\\settings.json`]: JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: `python ${W}\\.claude\\hooks\\done.py` }] }] } }),
      [`${W}\\.claude\\hooks\\done.py`]: 'print(1)\n',
      [`${W}\\.claude\\skills\\w\\SKILL.md`]: 'x\n'
    }
  })
  const env = await detectEnv(host)
  const { items } = await collectGlobal(host, env)
  const hook = items.find(i => i.kind === 'hook')
  expect((hook?.content.value as { hook: { command: string } }).hook.command).toBe('python ~/.claude/hooks/done.py')
  expect(hook?.requires).toEqual(['script:hooks/done.py'])
  expect(items.map(i => i.id).sort()).toEqual([hook?.id ?? '', 'script:hooks/done.py', 'skill:w'].sort())
  const linux = await setup({})
  for (const item of items) {
    if (item.content.files) for (const w of fileWrites(item, item.content.files, linux.env, {})) await linux.host.write(w.path, w.text ?? '')
    else await applyJson(linux.host, valueEdits(item, item.content.value, linux.env, {}))
  }
  expect(JSON.parse(linux.host.files.get(`${C}/settings.json`) ?? '{}').hooks.Stop[0].hooks[0].command).toBe('python /home/u/.claude/hooks/done.py')
  expect(linux.host.files.get(`${C}/hooks/done.py`)).toBe('print(1)\n')
})
