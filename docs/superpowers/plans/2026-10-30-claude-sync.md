# claude-sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Claude Code mod + marketplace that saves the user's Claude Code configuration (global, project, memory) to a private GitHub repo and brings it back on other machines, item by item, with profiles, versions and no secret ever pushed.

**Architecture:** One mod (hooks module in TypeScript). The UI is a focused pane (`$.ui.open`) opened from a clickable chip in the footer (`SessionMode`) and from `/sync`. All logic is plain TypeScript over a small `Host` interface (files + processes); the engine adapter maps it to `$.fs` / `$.process`, the tests map it to an in-memory fake `HOME` with scripted `git`/`gh`/`claude`.

**Tech Stack:** Claude Code mod API 2.1.314 (`claude-code` types), `git`, `gh`, `claude plugin` CLI. Tests: `claude plugin test`. Type-check: `tsc` 5.6 against the engine's declaration file.

**Spec:** `docs/superpowers/specs/2026-10-30-claude-sync-design.md`

## Global Constraints

- No secret reaches anything that is pushed: repo files, commit messages, manifest hashes (§4, §7). Strictest rule; tested end to end.
- Nothing is deleted without asking, element by element, with «apply to all» (§8.3).
- Never rewrite `settings.json` / `~/.claude.json` whole: merge keys; validate JSON after applying, restore the backup if invalid (§9.5.6-7).
- User machine needs only `git` and `gh`; the mod runs inside Claude Code's own runtime (no Node) (§5).
- UI strings in `hooks/i18n.ts`: one object per language, English default, Spanish when Claude's `language` setting, `LC_ALL`/`LC_MESSAGES`/`LANG` or the runtime locale say Spanish (§5, §12).
- Uploaded paths use `~` for home; expanded on apply (§9.6).
- Item ids, code and identifiers in English; user-facing docs also in Spanish (`README.es.md`).
- No code comments except a TODO or a non-obvious decision.

## Spike result (Task 0, done before this plan was finalised)

Verified with a throwaway mod under `claude plugin validate` + `claude plugin test` (engine 2.1.314):

| Question | Result |
|---|---|
| Draw in the footer | Yes: `ui.render` on `SessionMode` (right side of the prompt footer, terminal + desktop), as `sub-meter` does. |
| Clicks | A `Button plain` inside the `SessionMode` tree validates and its `onPress` runs (`ui.press`). `onPointer` exists only inside a `Client` surface module; a Button is enough and simpler. Real mouse clicks need the fullscreen terminal; `/sync` covers everyone else. |
| Interactive keyboard UI | Yes: `$.ui.open({ id, focus: true, closeOnEscape: true })` + `ui.render` on `Pane`. Tab/arrows walk Buttons, Enter presses, `Input` for text, `Select`, `Code format="diff"` for diffs, body scrolls. Opened on request it is placed at any width. |
| Files | `$.fs.read/write/list/exists/stat`. No delete: deletion goes through a process (`rm -rf` / `cmd /c rmdir|del`, `git rm` inside the sync repo). Read limit 4 MiB. |
| Processes | `$.process.run(argv, { cwd, stdin, timeoutMs ≤ 10 min })` and `$.process.spawn`; no shell. `git`, `gh`, `claude plugin …` all reachable. |
| Env / OS | `$.env.get` (literal names only). No platform field: OS from `OS=Windows_NT`, `WSL_DISTRO_NAME`, else `uname -s`. |
| Local state | `$.store` (JSON, per plugin, across sessions). Big data (repo clone, backups) in `~/.claude/plugins/data/claude-sync-claude-sync/`. |
| Tests | `claude plugin test` runs `*.test.ts`; `crypto.subtle`, `Intl` available; hooks beneath the plugin fake `$.fs`, `$.process`, `$.env`. |
| `claude plugin` | `install <p>@<m>` has no version flag → always installs the marketplace's current version and warns when it differs from the recorded one (the §9.5.8 fallback becomes the normal path). `configure <p> --values-stdin`, `uninstall`, `marketplace add` exist. |

**Decision:** the design's primary UI (mod chip + menu) works. No fallback script is needed; `/sync` opens the same pane.

Builder decisions recorded (§12):
- Runtime: the mod's own environment; no scripts, nothing to package.
- `gh auth login`: the first-run screen runs `gh auth login --web -h github.com -p https` through `$.process.spawn`, shows its one-time code and URL, and also shows the manual line (`! gh auth login`) in case the spawn cannot finish; then `gh auth setup-git`.
- `~/.claude.json` → `projects[path]`: configuration keys are `allowedTools`, `mcpServers`, `enabledMcpjsonServers`, `disabledMcpjsonServers`, `mcpContextUris`; everything else is state.
- `plugins/synced/` entries are opaque ids with no mapping to a plugin: not synced (deviation from §6.1, noted in README).
- Secret marker: `${secret:<name>}` where `<name>` is the dotted path (`mcp.github.env.GITHUB_TOKEN`).
- Diff: LCS line diff rendered as a unified diff; JSON diff by dotted path (`+`, `-`, `~`).
- Hash: SHA-256 of canonical JSON (sorted keys) of the item's content. Manifest stores the hash of the sanitized content only; local state stores the local hash.

## Review Focus

1. A token inside a JSON value nested in an array (MCP `args: ["--token", "ghp_…"]`) → replaced by a marker, never pushed. Test in Task 3.
2. Profile item that is `⚠ other system` and absent locally → never offered for removal on upload. Test in Task 5.
3. `settings.json` that does not parse before applying → nothing is written to it, the item is reported skipped, others still apply. Test in Task 7.
4. Importing a marker whose value exists locally at the same path → the local value is kept and not asked again. Test in Task 7.
5. Windows home (`C:\Users\x`) in a hook command → uploaded as `~/…`; expanded with backslashes on Windows. Test in Task 2.

---

## File Structure

```
.claude-plugin/plugin.json        manifest (name claude-sync, types contract)
.claude-plugin/marketplace.json   the repo is a marketplace
hooks/hooks.json                  { modules: ["./register.tsx"] }
hooks/register.tsx                wiring: /sync, footer chip, pane, session-start check
hooks/ui.tsx                      pane screens (menu, tree, diff, conflicts, questions, inputs, summary, setup)
hooks/app.ts                      operations: setup, upload, import, switch, mix, history, undo, status
hooks/host.ts                     Host interface + engine adapter
hooks/platform.ts                 OS, home, paths, ~ contraction/expansion, project id, memory dir, OS hints
hooks/hash.ts                     sha256, canonical JSON
hooks/inventory.ts                Item model + collect global/project/memory items + write items back
hooks/secrets.ts                  scan, markers, exceptions
hooks/diff.ts                     line diff (unified) + field diff
hooks/jsonmerge.ts                get/set/delete by path, merge item fragments into JSON files
hooks/profile.ts                  manifest, item statuses, upload/import plans, mix
hooks/repo.ts                     git/gh operations on the local clone
hooks/i18n.ts                     en + es strings, language detection
types/index.d.ts                  PluginState contract
tests/fake-host.ts                in-memory Host with fake HOME and scripted commands
tests/*.test.ts(x)
README.md, README.es.md, LICENSE, docs/images/*.svg
```

Item model (Task 3 produces, everyone consumes):

```ts
type Os = 'windows' | 'wsl' | 'macos' | 'linux'
type Kind = 'claude-md' | 'hook' | 'script' | 'permission' | 'setting' | 'skill' | 'agent' | 'command'
  | 'keybindings' | 'marketplace' | 'plugin' | 'plugin-data' | 'mcp'
  | 'project-file' | 'project-skill' | 'project-agent' | 'project-command' | 'project-config' | 'memory'
type Content = { files?: Record<string, string>; value?: Json }
type Item = { id: string; kind: Kind; project?: string; label: string; content: Content
  os?: Os; otherOs?: boolean; inProjectGit?: boolean; requires?: string[] }
```

Ids: `claude-md`, `hook:<event>:<matcher>:<sha8>`, `script:<rel>`, `permission:allow:<rule>`, `permission:deny:<rule>`, `permission:defaultMode`, `setting:<key>`, `skill:<n>`, `agent:<n>`, `command:<rel>`, `keybindings`, `marketplace:<n>`, `plugin:<p@m>`, `plugin-data:<p@m>`, `mcp:<n>`, `p:<projectId>:file:<rel>`, `p:<pid>:skill:<n>`, `p:<pid>:agent:<n>`, `p:<pid>:command:<rel>`, `p:<pid>:config:<key>`, `p:<pid>:memory:<file>`.

Manifest (`profiles/<p>/manifest.json`):

```json
{ "version": 1, "profile": "casa", "items": { "<id>": { "kind": "hook", "label": "…", "project": "github.com/u/r",
  "hash": "<sha256 of sanitized content>", "os": "linux", "updatedAt": "ISO", "path": "global/json/<slug>.json",
  "secrets": ["mcp.github.env.GITHUB_TOKEN"], "sensitiveOptions": ["apiKey"], "requires": ["script:hooks/x.py"] } } }
```

File items are stored under `path` as a folder of their files; value items as one JSON file. Exceptions: `exceptions.json` at the repo root, `{ "hashes": ["<sha256(itemId \0 text)>"] }`.

---

### Task 1: Scaffold, Host, hash, i18n

**Files:** Create `.claude-plugin/plugin.json`, `hooks/hooks.json`, `types/index.d.ts`, `tsconfig.json`, `hooks/host.ts`, `hooks/hash.ts`, `hooks/i18n.ts`, `tests/fake-host.ts`, Test `tests/basics.test.ts`

**Interfaces — Produces:**
- `interface Host { read(p): Promise<string|undefined>; write(p, text): Promise<void>; list(p): Promise<{name:string;kind:'file'|'directory'|'other'}[]>; exists(p): Promise<boolean>; remove(p): Promise<void>; run(argv: string[], opts?: { cwd?: string; stdin?: string; timeoutMs?: number }): Promise<{ code: number; stdout: string; stderr: string }>; env(name): Promise<string|undefined>; now(): number }`
- `engineHost($): Host` (env names spelled as literals: `HOME`, `USERPROFILE`, `OS`, `WSL_DISTRO_NAME`, `CLAUDE_CONFIG_DIR`, `LANG`, `LC_ALL`, `LC_MESSAGES`).
- `sha256(text): Promise<string>`, `canonical(value): string`.
- `type Lang = 'en'|'es'`; `strings: Record<Lang, Strings>`; `detectLang(settingLanguage, env): Lang`.
- `fakeHost({ env, files, commands })` where `commands` is a list of `(argv, opts) => result | undefined` handlers; records `ran: string[][]`.

- [ ] Test `detectLang`: `('spanish', {})`→`es`; `(undefined, {LANG:'es_ES.UTF-8'})`→`es`; `(undefined, {LANG:'C'}, 'en-US')`→`en`; `('english', {LANG:'es_ES'})`→`en`.
- [ ] Test `canonical({b:1,a:[{d:1,c:2}]})` === `'{"a":[{"c":2,"d":1}],"b":1}'`; `sha256('abc')` known vector.
- [ ] Test `i18n`: `Object.keys(strings.en)` equals `Object.keys(strings.es)`.
- [ ] Implement; run `claude plugin test .` → PASS.

### Task 2: Platform and paths

**Files:** Create `hooks/platform.ts`, Test `tests/platform.test.ts`

**Interfaces — Produces:**
- `type Env = { os: Os; home: string; sep: '/'|'\\'; claudeDir: string; claudeJson: string; dataDir: string }`; `detectEnv(host): Promise<Env>` (`CLAUDE_CONFIG_DIR` overrides `claudeDir`; `claudeJson` is `<home>/.claude.json`; `dataDir` `<claudeDir>/plugins/data/claude-sync-claude-sync`).
- `join(env, ...parts)`, `contractHome(text, home)`, `expandHome(text, env)`, `contractValue(json, home)`, `expandValue(json, env)` (recursive over strings).
- `encodeProjectPath(path)` → `path.replace(/[^A-Za-z0-9]/g, '-')`.
- `normalizeRemote(url)` → `github.com/user/repo` (drops protocol, credentials, `.git`, `git@host:` form).
- `osHints(text): Set<'windows'|'macos'|'linux'|'wsl'>`, `isOtherOs(hints, os): boolean` (`wsl` runs `linux` hints too).

- [ ] Tests: `contractHome('C:\\Users\\x\\.claude\\hooks\\a.py', 'C:\\Users\\x')` → `~/.claude/hooks/a.py`; `contractHome('/home/x/a /home/xy', '/home/x')` → `~/a /home/xy`; `expandHome('python ~/.claude/a.py', {os:'windows', home:'C:\\Users\\x', sep:'\\'})` → `python C:\\Users\\x\\.claude\\a.py`; `normalizeRemote('https://tok@github.com/U/r.git')` → `github.com/U/r`; `normalizeRemote('git@github.com:U/r.git')` → `github.com/U/r`; `encodeProjectPath('/mnt/c/A B')` → `-mnt-c-A-B`; `osHints('powershell -File x.ps1')` has `windows`; `isOtherOs(new Set(['linux']), 'wsl')` false; `isOtherOs(new Set(['windows']), 'macos')` true; `detectEnv` with `OS=Windows_NT, USERPROFILE=C:\\Users\\x` → `os: 'windows', sep: '\\'`; with `WSL_DISTRO_NAME` → `wsl`; else `uname -s` `Darwin` → `macos`.
- [ ] Implement; tests PASS.

### Task 3: Secrets

**Files:** Create `hooks/secrets.ts`, Test `tests/secrets.test.ts`

**Interfaces — Produces:**
- `TOKEN_PATTERNS` (`ghp_|gho_|ghu_|ghs_|ghr_` + 36, `github_pat_…`, `sk-…{20,}`, `xox[abposr]-…`, PEM `-----BEGIN … PRIVATE KEY-----`, `AKIA[0-9A-Z]{16}`, `AIza…{35}`, `glpat-…{20}`).
- `isSensitiveKey(name)` (`/token|key|secret|password|passwd|authorization|credential|bearer/i`, not `keybindings`-style false hits like `primaryKey`? kept simple: the regex).
- `type Finding = { itemId: string; file?: string; line?: number; path?: string; preview: string; hash: string }`
- `sanitize(item, exceptions: Set<string>, sensitiveOptions?: string[]): Promise<{ item: Item; secrets: string[]; blocked: Finding[] }>`:
  - value items: any string under a sensitive key (in objects, `env`, `headers`, `pluginConfigs`) or matching a token pattern anywhere (arrays included; `--token=x` / `["--api-key","x"]` in `args`) → `${secret:<dotted path>}`; values already a marker untouched.
  - file items: token pattern in text → `blocked` finding (masked preview `ghp_…abcd`), unless its exception hash is in `exceptions`.
- `exceptionHash(itemId, text)` = `sha256(itemId + '\0' + text)`.
- `isMarker(v)`, `markerName(v)`.

- [ ] Tests: env `{GITHUB_TOKEN:'abc', EDITOR:'vim'}` → token marked, `EDITOR` kept; MCP `args:['--token','ghp_'+36]` → arg replaced; `headers.Authorization:'Bearer x'` → marked; memory text with `ghp_…` → blocked with line number, item unchanged; same with exception hash → not blocked; exception for a different text in the same item → still blocked; a PEM key in a skill file → blocked; `secrets` lists marker names; the masked preview never contains the full token.
- [ ] Implement; PASS.

### Task 4: Inventory (collect + write back)

**Files:** Create `hooks/inventory.ts`, Test `tests/inventory.test.ts`

**Interfaces — Consumes:** Host, Env, `contractHome/expandHome`, `osHints`. **Produces:**
- `collectGlobal(host, env): Promise<Item[]>` — §6.1: `CLAUDE.md`; each hook command (event+matcher+command; `requires` scripts under `~/.claude` named in the command); `script:` for files under `~/.claude/hooks/` and the file named by `statusLine.command` when inside `~/.claude`; permission rules and `defaultMode`; other `settings.json` keys except `hooks`, `permissions`, `enabledPlugins`, `extraKnownMarketplaces`, `pluginConfigs`; skills (folder), agents, commands (recursive `.md`), `keybindings.json`; marketplaces (`known_marketplaces.json` source ∪ `extraKnownMarketplaces`); plugins (`installed_plugins.json` id, version, gitCommitSha, enabled from `enabledPlugins` of `settings.json` then `settings.local.json`, `pluginConfigs[id]`, `sensitiveOptions` from the plugin's `userConfig` with `sensitive: true`); `plugin-data:` (folder `plugins/data/<name>-<marketplace>/`, `plugins/store/<name>_<marketplace>-*.json`), skipping claude-sync's own; `mcp:` from `~/.claude.json` `mcpServers`. Nothing from §6.3 is ever read.
- `collectProject(host, env, root): Promise<{ id: string; items: Item[] }>` — §6.2: `.claude/{skills,agents,commands}`, `.claude/settings.json`, `.claude/settings.local.json`, `CLAUDE.md`, `CLAUDE.local.md`, `.mcp.json`, `~/.claude.json projects[root]` config keys, memory files; `inProjectGit` from `git ls-files`.
- `writeItem(host, env, item, target: { projectRoot?: string }): Promise<void>` and `removeItem(...)` — inverse of collect (files written with `~` expanded; value items merged via Task 6).
- Each item gets `otherOs` for kinds `hook|script|setting|mcp` when `isOtherOs(osHints(text), env.os)`.

- [ ] Tests with fake HOME holding a realistic tree (settings with 2 hooks one referencing `~/.claude/hooks/a.py`, permissions, `model`, statusLine, a skill folder, an agent, a nested command, installed + known marketplaces, `~/.claude.json` with `mcpServers` and internal keys, `history.jsonl`, `.credentials.json`, `plugins/cache/...`): ids are exactly the expected set; no item content contains anything from `history.jsonl`, `.credentials.json`, `plugins/cache`, or internal `~/.claude.json` keys; the hook `requires` `script:hooks/a.py`; a hook running `powershell` is `otherOs` on linux; project collection reads memory from `~/.claude/projects/<encoded>/memory/`, keeps only config keys of `projects[root]`, and marks tracked files `inProjectGit`.
- [ ] Round-trip test: `writeItem` of each collected item into an empty fake HOME then `collectGlobal` yields the same hashes.
- [ ] Implement; PASS.

### Task 5: Profiles, statuses and plans (§8.3, §8.4)

**Files:** Create `hooks/profile.ts`, Test `tests/profile.test.ts`

**Interfaces — Produces:**
- `type Manifest`, `type ManifestItem` (shape above); `type SyncState = { profile?: string; repo?: string; lastCommit?: Record<string,string>; hashes?: Record<string, Record<string,{ local: string; remote: string }>>; exceptions: string[] }`.
- `type Status = 'same'|'new'|'not-in-profile'|'modified'|'remote-changed'|'conflict'|'missing-local'|'other-os'|'secret'`.
- `uploadRows(local: Item[], localHashes, manifest, state): Row[]` and `importRows(manifest, local, localHashes, state): Row[]` where `Row = { id, kind, label, project?, status, checked }`. Defaults: upload checks profile items that changed; `not-in-profile` unchecked; `other-os` unchecked. Import checks `new`/`remote-changed`; conflicts unchecked until resolved.
- `pendingCount(rows)` → number for `●` (profile items changed or missing locally; not `not-in-profile`; not `other-os`).
- `planUpload(rows, selected)` → `{ put: string[]; askRemove: string[] }` — `askRemove` = profile items `missing-local` and not `other-os` (manifest `os` ≠ this os and hints say other system are never offered).
- `planImport(rows, selected, localByKind)` → `{ put: string[]; askDelete: string[] }` — `askDelete` = local items of a kind present in the selection but not in the profile; never `other-os`.
- `mix(sources: { profile: string; manifest: Manifest }[], picks: { profile: string; id: string }[], name)` → `{ manifest, copies: { from: string; to: string }[] }` (a copy, later picks of the same id win, conflict noted).

- [ ] Tests: unchanged profile item → `same`; local edit → `modified`, counted in `pendingCount`; new local skill → `not-in-profile`, unchecked, not counted; remote edit only → `remote-changed`; both → `conflict`; profile hook tagged windows, absent on macos → `other-os`, never in `askRemove`, not counted; deleted local profile item → `missing-local` in `askRemove`; import with local extra agent and selection containing agents → `askDelete` contains it, unchecked items never deleted; `mix` copies items and later edits to a source manifest do not change the mix result.
- [ ] Implement; PASS.

### Task 6: Diff and JSON merge

**Files:** Create `hooks/diff.ts`, `hooks/jsonmerge.ts`, Tests `tests/diff.test.ts`, `tests/jsonmerge.test.ts`

**Interfaces — Produces:**
- `lineDiff(a, b, path): string` (unified diff with `@@` hunks, 3 lines of context, `''` when equal); `fieldDiff(a, b): { path: string; op: '+'|'-'|'~'; before?: Json; after?: Json }[]`; `itemDiff(local?: Content, remote?: Content)` → `{ text?: string; fields?: FieldChange[] }`.
- `getPath`, `setPath`, `deletePath` over dotted paths with `[]`-free keys (keys may contain dots: paths are arrays internally).
- `mergeInto(fileText: string | undefined, edits: { path: string[]; value?: Json; remove?: boolean }[]): string` — throws `InvalidJson` when the existing text does not parse; preserves every key not edited; 2-space JSON with trailing newline.
- Hook entries merge: an item `hook:` adds its `{type, command}` under the matching `event`/`matcher` group, creating the group when absent, never duplicating; removal drops only that command and an empty group.
- Permission rules merge into the list without duplicates.

- [ ] Tests: `lineDiff` of a 1-line change shows `-old`/`+new` inside `@@ -1,3 +1,3 @@`; `fieldDiff({a:1,b:{c:2}}, {b:{c:3},d:4})` = `[-a, ~b.c, +d]`; `mergeInto` keeps unrelated keys and `"model"`; adding a hook twice leaves one; invalid JSON throws and nothing is returned.
- [ ] Implement; PASS.

### Task 7: Repo, apply, backup, undo (§9.4, §9.5, §9.7)

**Files:** Create `hooks/repo.ts`, `hooks/app.ts`, Test `tests/app.test.ts`

**Interfaces — Consumes:** everything above. **Produces:**
- `repo.ts`: `checkTools(host)` → `{ git: boolean; gh: boolean; ghAuthed: boolean; login?: string }`; `ensureRepo(host, env, login)` (`gh repo view <login>/claude-sync-config` else `gh repo create claude-sync-config --private`; clone into `<dataDir>/repo`; writes generated `README.md`); `fetch(host, env)`; `profiles(host, env)`; `headOf(host, env, profile)` (`git log -1 --format=%H origin/main -- profiles/<p>`); `readManifest(host, env, profile, commit?)`; `readItemContent(…)`; `history(host, env, profile)`; `commitAndPush(host, env, message, paths)` (`git add -A -- profiles exceptions.json README.md`, `git commit -m`, `git push -u origin HEAD:main`).
- `app.ts`: `status(ctx)` → `{ profile, pending, incoming }`; `prepareUpload(ctx)` → rows + findings; `upload(ctx, selected, answers: Record<id,'remove'|'keep'>)`; `prepareImport(ctx, commit?)` → rows + diffs; `importItems(ctx, selected, choices, answers, secretValues, target)` → `Summary { applied: string[]; skipped: { id: string; reason: string }[]; warnings: string[]; restart: boolean }`; `undo(ctx)`; `switchProfile(ctx, name)`; `createMix(ctx, name, picks)`. `ctx = { host, env, state, save(state), cwd }`.
- Import order: backup every file that will change into `<dataDir>/backup/` with `index.json` (`{ files: { path: original | null }, installed: string[] }`), replacing the previous backup; write files; merge JSON edits; `claude plugin marketplace add <source>`; `claude plugin install <p>@<m>` (warning when the installed version ≠ recorded); `claude plugin configure <p> --values-stdin` for plugin config and asked sensitive options; validate every touched JSON file parses, else restore from the backup and mark those items skipped; each item applies or is skipped alone.
- Secret values: for each marker in an item, keep the local value at the same path when it is not a marker; otherwise use `secretValues[name]`; none given → item skipped with reason `missing secret`.

- [ ] Test (strictest): upload from a fake HOME holding `GITHUB_TOKEN` in `env`, a token in an MCP arg, a token in a memory file with no exception, and a PEM key in a skill → every file the fake git sees under `<dataDir>/repo`, every commit message and every manifest hash input contain none of the secret strings; the memory item is reported blocked and not written. After the user marks that exact text «not a secret», the memory item uploads as-is: the excepted text is the only one that may appear, and only in that memory file; `exceptions.json` holds its hash, never the text.
- [ ] Test: import into a second fake HOME with existing `settings.json` holding `model` and its own `env.GITHUB_TOKEN` → hooks and permissions merged, `model` kept, local token kept, marker not written; plugin install argv recorded; summary lists applied items.
- [ ] Test: import where existing `~/.claude/settings.json` is invalid JSON → its items skipped with a reason, file untouched, other items applied.
- [ ] Test: `undo` restores the files and runs `claude plugin uninstall` for the plugins the import installed.
- [ ] Test: a plugin whose install fails is skipped and the rest applies; summary says why.
- [ ] Implement; PASS.

### Task 8: UI and wiring

**Files:** Create `hooks/ui.tsx`, `hooks/register.tsx`, Test `tests/ui.test.tsx`

**Interfaces — Consumes:** `app.ts`. **Produces:** screen atom `{ plugin: 'claude-sync', key: 'screen' }` (Shaped, `screen-1`) and `{ key: 'chip' }` (`{ profile?: string; pending: number; incoming: boolean }`).

- Chip in `SessionMode`: `⇅ <profile> ●↓` (`●` when `pending > 0`, `↓` when `incoming`), a `Button plain` that opens the pane; before the engine's own modes. Unconfigured: `⇅ sync`.
- `/sync` registered at `session.start`; status computed at session start (fetch) and after each operation, never on a timer.
- Screens: `setup` (tools check, login, repo, first profile name), `menu` (§9.2 entries + `Undo last apply` when a backup exists), `tree` (categories expandable, each item a Button `[x]`/`[ ]` + status tag; «all/none» per category; `Continue`), `secrets` (blocked findings with `Not a secret` per finding), `ask` (remove/keep per item + `Apply to all`), `diff` (`Code format="diff"` or field list), `conflict` (two versions, pick one), `values` (Input per missing secret / sensitive option), `target` (project folder Input), `summary`.
- Import first asks to upload when `pending > 0` (§9.5.1).

- [ ] Test: chip renders `⇅ casa ●↓` from chip state on `terminal` and `desktop`; pressing it calls `ui.open` with `focus: true`; `/sync` answers its own command and opens the pane; the menu shows the five §9.2 entries in the detected language (es when `LANG=es_ES.UTF-8`).
- [ ] Test: tree toggles an item and a category.
- [ ] Implement; PASS. Run `claude plugin validate .` → no errors.

### Task 9: Marketplace, docs, images

**Files:** Create `.claude-plugin/marketplace.json`, `LICENSE` (MIT, Jordi Tomás, 2026), `README.md`, `README.es.md`, `docs/images/header.svg`, `docs/images/how-it-travels.svg`, `docs/images/install-steps.svg`, placeholders `docs/images/screenshot-*.png` referenced in both READMEs.

- README sections (§10): what it is + never uploads secrets; create a GitHub account; install `git` and `gh` per OS (Windows `winget`, macOS `brew`, Debian/Ubuntu/WSL `apt`, Fedora `dnf`); install the plugin (`/plugin marketplace add Jorditomasg/claude-sync` + `/plugin install claude-sync@claude-sync`); first `/sync`; second machine; troubleshooting. Each links to the other language.
- SVGs: accent `#D77757`; text on transparent background uses `#D77757` and a mid grey (`#8B8B8B`) readable on white and on `#0d1117`; boxes filled with the accent and white text.
- [ ] `claude plugin validate .` → passes (marketplace + plugin).

## Recorded during implementation

- **Plugin name:** `claude plugin validate` refuses `claude-sync` (third-party names cannot start with `claude-`). The plugin is `config-sync`; the GitHub repo and the marketplace stay `claude-sync`, so install is `/plugin install config-sync@claude-sync`. `SELF` (plugin) and `SELF_MARKETPLACE` exclude claude-sync's own entries from the inventory.
- Collect functions return `{ items, warnings, project? }`: an unreadable JSON file is a warning, not a crash.
- `mix` returns the new `Manifest`; content is copied by `app.createMix`.
- `pendingCount(rows, state)` counts only items this machine synced before, so a fresh machine is never told it has "changes not uploaded".
- Undo restores JSON config (`settings.json`, `~/.claude.json`) path by path (the keys the apply touched), never the whole file: Claude Code rewrites `~/.claude.json` constantly. Whole-file rollback is kept in memory only, for an apply that leaves invalid JSON.
- Ids, keys and labels that embed user text (permission rules) have tokens masked; values still go through the marker sanitizer. A last check before every commit refuses any raw secret value or unexcepted token in the files written, the manifest or the commit message (`SecretLeak`).
- `withRequired` drags dependencies both ways: hooks → scripts on upload, plugins → marketplaces on import.
- Non-sensitive plugin options are merged into `pluginConfigs`; only `sensitive` ones go through `claude plugin configure --values-stdin`.

## Execution notes

Run everything from the repo root: `claude plugin test .`, `claude plugin validate .`, and `npx -y -p typescript@5.6.3 tsc -p <scratch tsconfig>` with a tsconfig outside the repo whose `include` names the engine's declaration file and the repo's `hooks`, `types`, `tests`.
