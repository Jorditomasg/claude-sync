import { expect, test } from 'claude-code/testing'
import { contractHome, detectEnv, encodeProjectPath, expandHome, isOtherOs, normalizeRemote, osHints } from '../hooks/platform'
import { fakeHost, ok, unameLinux } from './fake-host'

test('home is uploaded as ~ on every system', () => {
  expect(contractHome('C:\\Users\\x\\.claude\\hooks\\a.py --v', 'C:\\Users\\x')).toBe('~/.claude/hooks/a.py --v')
  expect(contractHome('python c:/users/X/.claude/a.py', 'C:\\Users\\x')).toBe('python ~/.claude/a.py')
  expect(contractHome('/home/x/a /home/xy "/home/x"', '/home/x')).toBe('~/a /home/xy "~"')
  expect(contractHome('/Users/ana/.claude/statusline.sh', '/Users/ana')).toBe('~/.claude/statusline.sh')
})

test('~ is expanded with the separator of this system', () => {
  const win = { os: 'windows', home: 'C:\\Users\\x', sep: '\\' } as const
  expect(expandHome('python ~/.claude/a.py', win)).toBe('python C:\\Users\\x\\.claude\\a.py')
  expect(expandHome('bash "~/.claude/s.sh"', { os: 'linux', home: '/home/u', sep: '/' })).toBe('bash "/home/u/.claude/s.sh"')
  expect(expandHome('a~b ~user', { os: 'linux', home: '/home/u', sep: '/' })).toBe('a~b ~user')
})

test('project identity comes from the remote, without credentials or .git', () => {
  expect(normalizeRemote('https://tok@github.com/U/r.git')).toBe('github.com/U/r')
  expect(normalizeRemote('git@github.com:U/r.git')).toBe('github.com/U/r')
  expect(normalizeRemote('ssh://git@GitHub.com:22/U/r/')).toBe('github.com/U/r')
  expect(encodeProjectPath('/mnt/c/A B')).toBe('-mnt-c-A-B')
  expect(encodeProjectPath('C:\\Users\\x\\p')).toBe('C--Users-x-p')
})

test('commands of another system are told apart', () => {
  expect(osHints('powershell -File x.ps1').has('windows')).toBe(true)
  expect(osHints('osascript -e beep').has('macos')).toBe(true)
  expect(osHints('notify-send done').has('linux')).toBe(true)
  expect(osHints('python3 ~/.claude/hooks/a.py').size).toBe(0)
  expect(isOtherOs(new Set(['linux']), 'wsl')).toBe(false)
  expect(isOtherOs(new Set(['windows']), 'macos')).toBe(true)
  expect(isOtherOs(new Set(['macos']), 'linux')).toBe(true)
  expect(isOtherOs(new Set(), 'windows')).toBe(false)
})

test('the system and its folders are detected', async () => {
  const win = await detectEnv(fakeHost({ env: { OS: 'Windows_NT', USERPROFILE: 'C:\\Users\\x' } }))
  expect(win).toEqual({ os: 'windows', home: 'C:\\Users\\x', sep: '\\', claudeDir: 'C:\\Users\\x\\.claude', claudeJson: 'C:\\Users\\x\\.claude.json', dataDir: 'C:\\Users\\x\\.claude\\plugins\\data\\config-sync-claude-sync' })
  expect((await detectEnv(fakeHost({ env: { HOME: '/home/u', WSL_DISTRO_NAME: 'Ubuntu' } }))).os).toBe('wsl')
  const mac = await detectEnv(fakeHost({ env: { HOME: '/Users/a' }, commands: [argv => (argv[0] === 'uname' ? ok('Darwin\n') : undefined)] }))
  expect(mac.os).toBe('macos')
  const linux = await detectEnv(fakeHost({ env: { HOME: '/home/u', CLAUDE_CONFIG_DIR: '/cfg' }, commands: [unameLinux] }))
  expect(linux).toMatchObject({ os: 'linux', claudeDir: '/cfg', claudeJson: '/cfg/.claude.json' })
})
