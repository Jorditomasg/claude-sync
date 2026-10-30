import type { Register } from 'claude-code'

import { chip, draw, language, openPane, refresh } from './ui'

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const t = await language($)
    await $.command.register({ name: 'sync', description: t.commandDescription })
    void refresh($)
    return next(e)
  })

  on('command.run', { command: 'sync' }, async ($) => {
    await openPane($)
    return { text: 'Claude Sync' }
  })

  on('ui.render', { component: 'SessionMode' }, async ($, e, next) => {
    const beneath = await next(e)
    return chip($, e, e.props.modes.length > 0 || beneath ? beneath : undefined)
  })

  on('ui.render', { component: 'Pane', requestId: 'config-sync' }, ($, e) => draw($, e))
}
