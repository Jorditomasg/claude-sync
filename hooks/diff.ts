import { canonical, type Json } from './hash'
import type { Content } from './inventory'

const CONTEXT = 3
const MAX_CELLS = 4_000_000

type Op = { op: ' ' | '-' | '+'; text: string; a: number; b: number }

function ops (a: string[], b: string[]): Op[] {
  if (a.length * b.length > MAX_CELLS) {
    return [...a.map((text, i) => ({ op: '-' as const, text, a: i, b: 0 })), ...b.map((text, j) => ({ op: '+' as const, text, a: a.length, b: j }))]
  }
  const w = b.length + 1
  const lcs = new Uint32Array((a.length + 1) * w)
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i * w + j] = a[i] === b[j] ? (lcs[(i + 1) * w + j + 1] ?? 0) + 1 : Math.max(lcs[(i + 1) * w + j] ?? 0, lcs[i * w + j + 1] ?? 0)
    }
  }
  const out: Op[] = []
  let i = 0
  let j = 0
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) out.push({ op: ' ', text: a[i++] ?? '', a: i - 1, b: j++ })
    else if (i < a.length && (j >= b.length || (lcs[(i + 1) * w + j] ?? 0) >= (lcs[i * w + j + 1] ?? 0))) out.push({ op: '-', text: a[i++] ?? '', a: i - 1, b: j })
    else out.push({ op: '+', text: b[j++] ?? '', a: i, b: j - 1 })
  }
  return out
}

const lines = (text: string) => (text === '' ? [] : text.replace(/\n$/, '').split('\n'))

export function lineDiff (before: string, after: string, path: string): string {
  if (before === after) return ''
  const all = ops(lines(before), lines(after))
  const changed = all.map((o, k) => (o.op !== ' ' ? k : -1)).filter(k => k >= 0)
  const hunks: [number, number][] = []
  for (const k of changed) {
    const start = Math.max(0, k - CONTEXT)
    const end = Math.min(all.length - 1, k + CONTEXT)
    const last = hunks[hunks.length - 1]
    if (last && start <= last[1] + 1) last[1] = Math.max(last[1], end)
    else hunks.push([start, end])
  }
  const out = [`--- a/${path}`, `+++ b/${path}`]
  for (const [start, end] of hunks) {
    const part = all.slice(start, end + 1)
    const aCount = part.filter(o => o.op !== '+').length
    const bCount = part.filter(o => o.op !== '-').length
    const first = part[0]
    const aStart = aCount === 0 ? (first?.a ?? 0) : (part.find(o => o.op !== '+')?.a ?? 0) + 1
    const bStart = bCount === 0 ? (first?.b ?? 0) : (part.find(o => o.op !== '-')?.b ?? 0) + 1
    out.push(`@@ -${aStart},${aCount} +${bStart},${bCount} @@`, ...part.map(o => o.op + o.text))
  }
  return out.join('\n') + '\n'
}

export type FieldChange = { path: string; op: '+' | '-' | '~'; before?: Json; after?: Json }

const isObj = (v: unknown): v is Record<string, Json> => v !== null && typeof v === 'object' && !Array.isArray(v)

export function fieldDiff (before: Json | undefined, after: Json | undefined, path = ''): FieldChange[] {
  if (canonical(before) === canonical(after)) return []
  if (isObj(before) && isObj(after)) {
    const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])]
    return keys.flatMap(k => fieldDiff(before[k], after[k], path ? `${path}.${k}` : k))
  }
  if (before === undefined) return [{ path, op: '+', after }]
  if (after === undefined) return [{ path, op: '-', before }]
  return [{ path, op: '~', before, after }]
}

export type ItemDiff = { text?: string; fields?: FieldChange[] }

export function itemDiff (local: Content | undefined, remote: Content | undefined): ItemDiff {
  if (local?.files || remote?.files) {
    const a = local?.files ?? {}
    const b = remote?.files ?? {}
    const names = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()
    return { text: names.map(n => lineDiff(a[n] ?? '', b[n] ?? '', n)).join('') }
  }
  return { fields: fieldDiff(local?.value, remote?.value) }
}
