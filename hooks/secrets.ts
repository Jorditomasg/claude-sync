import { sha256, type Json } from './hash'

export const TOKEN_PATTERNS: RegExp[] = [
  /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{22,}\b/g,
  /\bsk-[A-Za-z0-9_-]{20,}/g,
  /\bxox[abposr]-[A-Za-z0-9-]{10,}/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bAIza[0-9A-Za-z_-]{35}/g,
  /\bglpat-[A-Za-z0-9_-]{20,}/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/g
]

const SENSITIVE = /token|secret|password|passwd|passphrase|authorization|credential|bearer|api[_-]?key|private[_-]?key|access[_-]?key|(^|[_-])key$|^key$/i
const ARG_FLAG = /^--?([A-Za-z0-9_-]+)(=(.*))?$/

export const isSensitiveKey = (name: string) => SENSITIVE.test(name)
export const marker = (name: string) => `\${secret:${name}}`
export const MARKER = /\$\{secret:([^}]+)\}/g
export const isMarker = (value: unknown) => typeof value === 'string' && /^\$\{secret:[^}]+\}$/.test(value)
export const markersIn = (text: string) => [...text.matchAll(MARKER)].map(m => m[1] ?? '')

export function findTokens (text: string): { text: string; index: number }[] {
  const found: { text: string; index: number }[] = []
  for (const re of TOKEN_PATTERNS) {
    for (const m of text.matchAll(re)) found.push({ text: m[0], index: m.index ?? 0 })
  }
  return found.sort((a, b) => a.index - b.index)
}

export const maskTokens = (text: string) => findTokens(text).reduce((t, f) => t.replace(f.text, '***'), text)

export function preview (token: string): string {
  const flat = token.replace(/\s+/g, ' ')
  if (flat.startsWith('-----BEGIN')) return flat.slice(0, flat.indexOf('KEY-----') + 8) + ' …'
  return `${flat.slice(0, 4)}…${flat.length > 16 ? flat.slice(-2) : ''}`
}

export const exceptionHash = (itemId: string, text: string) => sha256(`${itemId}\0${text}`)

export type Finding = { itemId: string; file: string; line: number; preview: string; hash: string }

export function sanitizeValue (value: Json, name: string, isSensitive = false): { value: Json; secrets: string[]; raw: string[] } {
  const secrets: string[] = []
  const raw: string[] = []
  const walk = (v: Json, path: string, sensitive: boolean): Json => {
    if (typeof v === 'string') {
      if (isMarker(v)) return v
      if (sensitive && v !== '') { secrets.push(path); raw.push(v); return marker(path) }
      let n = 0
      let out = v
      for (const token of findTokens(v)) {
        const id = n++ === 0 ? path : `${path}#${n}`
        secrets.push(id)
        raw.push(token.text)
        out = out.replace(token.text, marker(id))
      }
      return out
    }
    if (Array.isArray(v)) {
      return v.map((x, i) => {
        const prev = i > 0 ? v[i - 1] : undefined
        const flag = typeof prev === 'string' ? ARG_FLAG.exec(prev) : null
        if (typeof x === 'string') {
          const own = ARG_FLAG.exec(x)
          if (own?.[3] && isSensitiveKey(own[1] ?? '') && !isMarker(own[3])) {
            secrets.push(`${path}.${i}`)
            raw.push(own[3])
            return `--${own[1]}=${marker(`${path}.${i}`)}`
          }
        }
        return walk(x, `${path}.${i}`, sensitive || (flag !== null && !flag[3] && isSensitiveKey(flag[1] ?? '')))
      })
    }
    if (v !== null && typeof v === 'object') {
      return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x, `${path}.${k}`, sensitive || isSensitiveKey(k))]))
    }
    return v
  }
  return { value: walk(value, name, isSensitive), secrets, raw }
}

export async function scanFiles (itemId: string, files: Record<string, string>, exceptions: ReadonlySet<string>): Promise<Finding[]> {
  const findings: Finding[] = []
  for (const [file, text] of Object.entries(files)) {
    for (const token of findTokens(text)) {
      const hash = await exceptionHash(itemId, token.text)
      if (exceptions.has(hash)) continue
      findings.push({ itemId, file, line: text.slice(0, token.index).split('\n').length, preview: preview(token.text), hash })
    }
  }
  return findings
}

export function fillMarkers (value: Json, name: string, local: Json | undefined, values: Record<string, string>): { value: Json; missing: string[] } {
  const missing: string[] = []
  const clean = local === undefined ? undefined : sanitizeValue(local, name).value
  const at = (v: Json | undefined, k: string | number): Json | undefined =>
    v !== null && typeof v === 'object' ? (v as Record<string, Json>)[k] : undefined
  const walk = (v: Json, raw: Json | undefined, safe: Json | undefined): Json => {
    if (typeof v === 'string') {
      if (!v.includes('${secret:')) return v
      if (typeof raw === 'string' && safe === v) return raw
      return v.replace(MARKER, (all, id: string) => {
        const given = values[id]
        if (given === undefined || given === '') { missing.push(id); return all }
        return given
      })
    }
    if (Array.isArray(v)) return v.map((x, i) => walk(x, at(raw, i), at(safe, i)))
    if (v !== null && typeof v === 'object') {
      return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x, at(raw, k), at(safe, k))]))
    }
    return v
  }
  return { value: walk(value, local, clean), missing }
}
