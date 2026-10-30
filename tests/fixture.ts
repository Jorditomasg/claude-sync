export const GH = 'ghp_' + 'Z9y8X7w6V5u4T3s2R1q0P9o8N7m6L5k4J3i2'
export const PEM = '-----BEGIN RSA ' + 'PRIVATE KEY-----\nMIIEowIBAAKCAQEA7\n-----END RSA ' + 'PRIVATE KEY-----'
export const H = '/home/u'
export const C = '/home/u/.claude'

const json = (v: unknown) => JSON.stringify(v, null, 2)

export function machineA (): Record<string, string> {
  return {
    [`${C}/CLAUDE.md`]: '# Rules\nUse /home/u/bin when needed.\n',
    [`${C}/settings.json`]: json({
      model: 'opus',
      env: { GITHUB_TOKEN: 'secret-env-value', EDITOR: 'vim' },
      statusLine: { type: 'command', command: 'bash /home/u/.claude/statusline.sh' },
      permissions: { allow: ['Bash(git status)'], deny: ['Read(.env)'], defaultMode: 'acceptEdits' },
      hooks: {
        PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'python3 /home/u/.claude/hooks/guard.py' }] }],
        Stop: [{ hooks: [{ type: 'command', command: 'powershell -File C:\\x\\beep.ps1' }] }]
      },
      enabledPlugins: { 'tool@market': true },
      extraKnownMarketplaces: { market: { source: { source: 'github', repo: 'o/market' } } },
      pluginConfigs: { 'tool@market': { options: { mode: 'fast', apiKey: 'plain-config-secret' } } }
    }),
    [`${C}/statusline.sh`]: 'echo hi\n',
    [`${C}/hooks/guard.py`]: 'print("guard")\n',
    [`${C}/skills/writer/SKILL.md`]: '---\nname: writer\n---\nWrite well.\n',
    [`${C}/skills/writer/ref/notes.md`]: 'notes\n',
    [`${C}/skills/keys/SKILL.md`]: `Here is a key:\n${PEM}\n`,
    [`${C}/agents/reviewer.md`]: '# reviewer\n',
    [`${C}/commands/git/ship.md`]: 'ship it\n',
    [`${C}/keybindings.json`]: '{}\n',
    [`${C}/plugins/known_marketplaces.json`]: json({ market: { source: { source: 'github', repo: 'o/market' }, installLocation: `${C}/plugins/marketplaces/market` }, 'claude-sync': { source: { source: 'github', repo: 'Jorditomasg/claude-sync' } } }),
    [`${C}/plugins/installed_plugins.json`]: json({ version: 2, plugins: { 'tool@market': [{ scope: 'user', installPath: `${C}/plugins/cache/market/tool/1.2.0`, version: '1.2.0', gitCommitSha: 'abc123' }], 'config-sync@claude-sync': [{ scope: 'user', installPath: '/x', version: '0.1.0' }] } }),
    [`${C}/plugins/cache/market/tool/1.2.0/.claude-plugin/plugin.json`]: json({ name: 'tool', userConfig: { apiKey: { type: 'string', sensitive: true }, mode: { type: 'string' } } }),
    [`${C}/plugins/data/tool-market/db.json`]: '{"n":1}',
    [`${C}/plugins/data/config-sync-claude-sync/repo/x`]: 'own data',
    [`${C}/plugins/store/tool_market-1234.json`]: '{"k":1}',
    [`${C}/history.jsonl`]: 'HISTORY-LEAK\n',
    [`${C}/.credentials.json`]: 'CREDENTIALS-LEAK',
    [`${C}/sessions/s.json`]: 'SESSION-LEAK',
    [`${C}/projects/-home-u-work-app/abc.jsonl`]: 'TRANSCRIPT-LEAK',
    [`${C}/projects/-home-u-work-app/memory/MEMORY.md`]: '- [a](a.md)\n',
    [`${C}/projects/-home-u-work-app/memory/a.md`]: `token ${GH} here\n`,
    [`${H}/.claude.json`]: json({
      oauthAccount: { email: 'OAUTH-LEAK' },
      userID: 'USERID-LEAK',
      mcpServers: { github: { command: 'npx', args: ['-y', 'gh-mcp', '--token', GH], env: { GITHUB_PERSONAL_ACCESS_TOKEN: 'mcp-secret' } } },
      projects: { '/home/u/work/app': { allowedTools: ['Bash(ls)'], lastCost: 1.5, lastSessionId: 'SESSION-ID-LEAK', mcpServers: {} } }
    }),
    [`${H}/work/app/CLAUDE.md`]: '# App\nRun /home/u/work/app/run.sh\n',
    [`${H}/work/app/.claude/settings.json`]: json({ permissions: { allow: ['Bash(npm test)'] } }),
    [`${H}/work/app/.claude/agents/tester.md`]: '# tester\n',
    [`${H}/work/app/.mcp.json`]: json({ mcpServers: {} })
  }
}

export const LEAKS = ['HISTORY-LEAK', 'CREDENTIALS-LEAK', 'SESSION-LEAK', 'TRANSCRIPT-LEAK', 'OAUTH-LEAK', 'USERID-LEAK', 'SESSION-ID-LEAK', 'own data']
export const SECRETS = [GH, 'secret-env-value', 'mcp-secret', 'MIIEowIBAAKCAQEA7']
