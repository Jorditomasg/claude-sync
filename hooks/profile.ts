import { isFileKind, type Item, type Kind } from './inventory'
import { isOtherOs, type Os } from './platform'

export type ManifestItem = {
  kind: Kind
  key: string
  label: string
  hash: string
  os: Os
  updatedAt: string
  path: string
  project?: string
  secrets?: string[]
  sensitiveOptions?: string[]
  requires?: string[]
  hints?: string[]
  inProjectGit?: boolean
}
export type Manifest = { version: 1; profile: string; items: Record<string, ManifestItem> }
export type ProfileState = { commit?: string; synced: Record<string, string> }
export type SyncState = { repo?: string; profile?: string; profiles: Record<string, ProfileState>; exceptions: string[] }

export type Status = 'same' | 'new' | 'not-in-profile' | 'modified' | 'remote-changed' | 'conflict' | 'missing-local' | 'other-os' | 'secret'
export type Row = { id: string; kind: Kind; label: string; project?: string; status: Status; checked: boolean; inProjectGit?: boolean; requires?: string[] }

export const emptyManifest = (profile: string): Manifest => ({ version: 1, profile, items: {} })
export const emptyState = (): SyncState => ({ profiles: {}, exceptions: [] })

const slug = (text: string) => text.replace(/[^A-Za-z0-9._-]/g, c => `_${c.charCodeAt(0).toString(16).padStart(2, '0')}`)

export function storagePath (item: Pick<Item, 'kind' | 'key' | 'project'>): string {
  const scope = item.project ? `projects/${slug(item.project)}` : 'global'
  return `${scope}/${item.kind}/${slug(item.key)}${isFileKind(item.kind) ? '' : '.json'}`
}

const otherOs = (m: ManifestItem, os: Os) => isOtherOs(m.hints ?? [], os)

export function uploadRows (local: readonly Item[], hashes: Record<string, string>, manifest: Manifest, state: ProfileState, os: Os): Row[] {
  const rows: Row[] = []
  for (const item of local) {
    const m = manifest.items[item.id]
    const base = { id: item.id, kind: item.kind, label: item.label, project: item.project, inProjectGit: item.inProjectGit, requires: item.requires }
    if (!m) { rows.push({ ...base, status: 'not-in-profile', checked: false }); continue }
    const h = hashes[item.id]
    const synced = state.synced[item.id]
    if (h === m.hash) rows.push({ ...base, status: 'same', checked: false })
    else if (synced !== undefined && h !== synced && m.hash === synced) rows.push({ ...base, status: 'modified', checked: true })
    else if (synced !== undefined && h === synced) rows.push({ ...base, status: 'remote-changed', checked: false })
    else rows.push({ ...base, status: 'conflict', checked: false })
  }
  const here = new Set(local.map(i => i.id))
  for (const [id, m] of Object.entries(manifest.items)) {
    if (here.has(id) || state.synced[id] === undefined || otherOs(m, os)) continue
    rows.push({ id, kind: m.kind, label: m.label, project: m.project, status: 'missing-local', checked: true })
  }
  return rows
}

export function importRows (manifest: Manifest, local: readonly Item[], hashes: Record<string, string>, state: ProfileState, os: Os): Row[] {
  const byId = new Map(local.map(i => [i.id, i]))
  return Object.entries(manifest.items).map(([id, m]): Row => {
    const base = { id, kind: m.kind, label: m.label, project: m.project, inProjectGit: m.inProjectGit, requires: m.requires }
    const synced = state.synced[id]
    if (otherOs(m, os)) return { ...base, status: 'other-os', checked: false }
    if (!byId.has(id)) return synced === undefined ? { ...base, status: 'new', checked: true } : { ...base, status: 'missing-local', checked: false }
    const h = hashes[id]
    if (h === m.hash) return { ...base, status: 'same', checked: false }
    if (synced !== undefined && h === synced) return { ...base, status: 'remote-changed', checked: true }
    if (synced !== undefined && m.hash === synced) return { ...base, status: 'modified', checked: false }
    return { ...base, status: 'conflict', checked: false }
  })
}

export const pendingCount = (rows: readonly Row[], state: ProfileState) =>
  rows.filter(r => state.synced[r.id] !== undefined && (r.status === 'modified' || r.status === 'conflict' || r.status === 'missing-local')).length

export function withRequired (rows: readonly Row[], selected: ReadonlySet<string>): Set<string> {
  const known = new Set(rows.filter(r => r.status !== 'secret' && r.status !== 'other-os').map(r => r.id))
  const out = new Set(selected)
  const queue = [...selected]
  while (queue.length > 0) {
    const next = queue.pop()
    const row = rows.find(r => r.id === next)
    for (const dep of row?.requires ?? []) {
      if (known.has(dep) && !out.has(dep)) { out.add(dep); queue.push(dep) }
    }
  }
  return out
}

export function planUpload (rows: readonly Row[], selected: ReadonlySet<string>): { put: string[]; askRemove: string[] } {
  const chosen = rows.filter(r => selected.has(r.id) && r.status !== 'same' && r.status !== 'secret')
  return { put: chosen.filter(r => r.status !== 'missing-local').map(r => r.id), askRemove: chosen.filter(r => r.status === 'missing-local').map(r => r.id) }
}

export function planImport (rows: readonly Row[], selected: ReadonlySet<string>, local: readonly Item[], targetProject?: string): { put: string[]; askDelete: string[] } {
  const put = rows.filter(r => selected.has(r.id) && r.status !== 'same' && r.status !== 'other-os').map(r => r.id)
  const inProfile = new Set(rows.map(r => r.id))
  const kinds = new Set(rows.filter(r => selected.has(r.id)).map(r => r.kind))
  const askDelete = local.filter(i => kinds.has(i.kind) && !inProfile.has(i.id) && (i.project === undefined || i.project === targetProject)).map(i => i.id)
  return { put, askDelete }
}

export function mix (sources: readonly { profile: string; manifest: Manifest }[], picks: readonly { profile: string; id: string }[], name: string): Manifest {
  const manifest = emptyManifest(name)
  for (const pick of picks) {
    const item = sources.find(s => s.profile === pick.profile)?.manifest.items[pick.id]
    if (item) manifest.items[pick.id] = structuredClone(item)
  }
  return manifest
}
