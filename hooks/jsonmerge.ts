import { canonical, type Json } from './hash'

type Obj = { [key: string]: Json }
export type HookEntry = { event: string; matcher?: string; hook: Json }
export type Edit =
  | { path: string[]; value?: Json; remove?: boolean }
  | { list: string[]; entry: Json; remove?: boolean }
  | { hook: HookEntry; remove?: boolean }

export class InvalidJson extends Error {}

const isObj = (v: unknown): v is Obj => v !== null && typeof v === 'object' && !Array.isArray(v)

export function parseJson (text: string | undefined, file = 'file'): Obj {
  if (text === undefined || text.trim() === '') return {}
  try {
    const value = JSON.parse(text) as Json
    if (!isObj(value)) throw new Error('not an object')
    return value
  } catch (error) {
    throw new InvalidJson(`${file}: ${(error as Error).message}`)
  }
}

export function getPath (value: Json | undefined, path: readonly string[]): Json | undefined {
  let at: Json | undefined = value
  for (const key of path) at = isObj(at) ? at[key] : undefined
  return at
}

function parentOf (root: Obj, path: readonly string[]): Obj {
  let at = root
  for (const key of path) {
    const next = at[key]
    if (!isObj(next)) at[key] = {}
    at = at[key] as Obj
  }
  return at
}

export function setPath (root: Obj, path: readonly string[], value: Json): void {
  parentOf(root, path.slice(0, -1))[path[path.length - 1] ?? ''] = value
}

export function deletePath (root: Obj, path: readonly string[]): void {
  const parents: Obj[] = [root]
  for (const key of path.slice(0, -1)) {
    const next = parents[parents.length - 1]?.[key]
    if (!isObj(next)) return
    parents.push(next)
  }
  delete parents[parents.length - 1]?.[path[path.length - 1] ?? '']
  for (let i = parents.length - 1; i > 0; i--) {
    if (Object.keys(parents[i] ?? {}).length > 0) break
    delete parents[i - 1]?.[path[i - 1] ?? '']
  }
}

function applyHook (root: Obj, { event, matcher, hook }: HookEntry, remove: boolean): void {
  const hooks = parentOf(root, ['hooks'])
  const groups = (Array.isArray(hooks[event]) ? hooks[event] : []) as Obj[]
  const same = (g: Obj) => (g.matcher ?? '') === (matcher ?? '')
  let group = groups.find(same)
  if (!group) {
    if (remove) return
    group = matcher === undefined ? { hooks: [] } : { matcher, hooks: [] }
    groups.push(group)
  }
  const list = (Array.isArray(group.hooks) ? group.hooks : []) as Json[]
  const rest = list.filter(h => canonical(h) !== canonical(hook))
  group.hooks = remove ? rest : [...rest, hook]
  const kept = groups.filter(g => Array.isArray(g.hooks) && g.hooks.length > 0)
  if (kept.length > 0) hooks[event] = kept
  else delete hooks[event]
  if (Object.keys(hooks).length === 0) delete root.hooks
}

export function mergeInto (text: string | undefined, edits: readonly Edit[], file?: string): string {
  const root = parseJson(text, file)
  for (const edit of edits) {
    if ('hook' in edit) applyHook(root, edit.hook, edit.remove === true)
    else if ('list' in edit) {
      const current = getPath(root, edit.list)
      const list = (Array.isArray(current) ? current : []).filter(e => canonical(e) !== canonical(edit.entry))
      if (!edit.remove) list.push(edit.entry)
      if (list.length > 0) setPath(root, edit.list, list)
      else deletePath(root, edit.list)
    } else if (edit.remove || edit.value === undefined) deletePath(root, edit.path)
    else setPath(root, edit.path, edit.value)
  }
  return JSON.stringify(root, null, 2) + '\n'
}
