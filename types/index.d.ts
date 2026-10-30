export type ClaudeSyncChip = { isReady: boolean; profile?: string; pending: number; incoming: boolean }
export type ClaudeSyncScreen = { name: string; data?: unknown }

declare module 'claude-code' {
  interface PluginState {
    'config-sync': {
      chip: Shaped<ClaudeSyncChip>
      screen: Shaped<ClaudeSyncScreen>
    }
  }
}
