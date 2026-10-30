import type { Host } from './host'
import type { Json } from './hash'

export type Os = 'windows' | 'wsl' | 'macos' | 'linux'
export type Env = { os: Os; home: string; sep: '/' | '\\'; claudeDir: string; claudeJson: string; dataDir: string }

export async function detectOs (host: Host): Promise<Os> {
  if ((await host.env('OS')) === 'Windows_NT') return 'windows'
  if (await host.env('WSL_DISTRO_NAME')) return 'wsl'
  const uname = await host.run(['uname', '-s'])
  if (/darwin/i.test(uname.stdout)) return 'macos'
  if (/microsoft/i.test((await host.run(['uname', '-r'])).stdout)) return 'wsl'
  return 'linux'
}

export async function detectEnv (host: Host): Promise<Env> {
  const os = await detectOs(host)
  const home = (os === 'windows' ? (await host.env('USERPROFILE')) ?? (await host.env('HOME')) : await host.env('HOME')) ?? ''
  const sep = os === 'windows' ? '\\' : '/'
  const base = { os, home, sep } as const
  const configDir = await host.env('CLAUDE_CONFIG_DIR')
  const claudeDir = configDir ? join(base, configDir) : join(base, home, '.claude')
  return {
    ...base,
    claudeDir,
    claudeJson: configDir ? join(base, configDir, '.claude.json') : join(base, home, '.claude.json'),
    dataDir: join(base, claudeDir, 'plugins', 'data', 'config-sync-claude-sync')
  }
}

export function join (env: { sep: string }, ...parts: string[]): string {
  const joined = parts.filter(p => p !== '').join('/').replace(/[\\/]+/g, '/')
  return env.sep === '\\' ? joined.replace(/\//g, '\\') : joined
}

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const isWindowsPath = (path: string) => /^[A-Za-z]:[\\/]/.test(path) || path.includes('\\')

export function contractPath (text: string, base: string, replacement: string): string {
  if (!base) return text
  const trimmed = base.replace(/[\\/]+$/, '')
  const windows = isWindowsPath(trimmed)
  const pattern = escape(trimmed).replace(/\\\\|\//g, '[\\\\/]')
  const tail = windows ? '([^\\s"\'`]*)' : '()'
  const re = new RegExp(`${pattern}(?=[\\\\/]|$|[^A-Za-z0-9_.-])${tail}`, windows ? 'gi' : 'g')
  return text.replace(re, (_all, rest: string) => replacement + (rest ?? '').replace(/\\/g, '/'))
}

export const contractHome = (text: string, home: string) => contractPath(text, home, '~')

export function expandHome (text: string, env: Pick<Env, 'os' | 'home' | 'sep'>): string {
  return text.replace(/(^|[\s"'=(:,])~(?=[\\/]|$|[\s"'])([^\s"'`]*)/g, (_all, lead: string, rest: string) =>
    lead + env.home + (env.sep === '\\' ? rest.replace(/\//g, '\\') : rest))
}

export function mapStrings (value: Json, fn: (text: string) => string): Json {
  if (typeof value === 'string') return fn(value)
  if (Array.isArray(value)) return value.map(v => mapStrings(v, fn))
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, mapStrings(v, fn)]))
  }
  return value
}

export const encodeProjectPath = (path: string) => path.replace(/[^A-Za-z0-9]/g, '-')

export function normalizeRemote (url: string): string {
  let rest = url.trim()
  const scp = /^[^@/:]+@([^:/]+):(.+)$/.exec(rest)
  if (scp && !rest.includes('://')) rest = `${scp[1]}/${scp[2]}`
  rest = rest.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').replace(/^[^@/]+@/, '')
  rest = rest.replace(/\/+$/, '').replace(/\.git$/, '')
  const [host = '', ...path] = rest.split('/')
  return [host.toLowerCase().replace(/:\d+$/, ''), ...path].join('/')
}

export const basename = (path: string) => path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? path

type Hint = 'windows' | 'macos' | 'linux' | 'wsl'
const HINTS: [Hint, RegExp][] = [
  ['windows', /\.(exe|bat|cmd|ps1)\b|\bpowershell\b|\bpwsh\b|\bcmd(\.exe)?\s+\/c\b|\b[A-Za-z]:\\|%[A-Z_]+%/i],
  ['macos', /\bosascript\b|\bpbcopy\b|\bpbpaste\b|\bafplay\b|\bopen -a\b|\/opt\/homebrew\b|\/Applications\/|\bterminal-notifier\b/],
  ['linux', /\bnotify-send\b|\bxdg-open\b|\bapt(-get)?\s|\bpaplay\b|\bwl-copy\b|\bxclip\b|\bxsel\b/],
  ['wsl', /\/mnt\/[a-z]\/|\bwslpath\b|\bwsl\.exe\b/]
]
const COMPATIBLE: Record<Os, Hint[]> = {
  windows: ['windows'],
  wsl: ['wsl', 'linux', 'windows'],
  linux: ['linux'],
  macos: ['macos']
}

export function osHints (text: string): Set<Hint> {
  return new Set(HINTS.filter(([, re]) => re.test(text)).map(([hint]) => hint))
}

export function isOtherOs (hints: Iterable<string>, os: Os): boolean {
  const list = [...hints]
  return list.length > 0 && !list.some(h => (COMPATIBLE[os] as string[]).includes(h))
}
