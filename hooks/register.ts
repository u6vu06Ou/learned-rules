import type { Register } from 'claude-code'
import { buildInjection, inputSummary, lessonsCmd, recordFailure, remindCmd } from './lib'

export const register: Register = on => {

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'lessons', description: 'learned-rules: unresolved failures and active rule counts, with triage instructions for the agent' })
    await $.command.register({
      name: 'remind',
      description: 'Dated reminders, surfaced in a new conversation when due (learned-rules)',
      argumentHint: 'add YYYY-MM-DD <text> | list | done <id>',
    })
    return next(e)
  })

  // Failure capture: the tool result comes back with `isError` when the tool
  // threw, was interrupted or answered an error. Record it; recording is
  // best-effort and can never block or break the call.
  on('tool.call', async ($, e, next) => {
    const r = await next(e)
    try {
      if ((r as any)?.isError === true) {
        const text = typeof (r as any).text === 'string'
          ? (r as any).text
          : (() => { try { return JSON.stringify((r as any).result) } catch { return '' } })()
        await recordFailure($, String((e as any).tool), inputSummary(e), text, await $.clock.now())
      }
    } catch { /* a broken recorder must not swallow the result */ }
    return r
  }).catch(($, e, next) => next.called ? undefined as any : next(e)) // guard broken -> the call goes through

  // Session-start injection: `prompt.context` fires once per conversation, so
  // the block rides the first user message and survives compaction. A hook
  // that fails passes through unchanged.
  on('prompt.context', async ($, e, next) => {
    const block = await buildInjection($, await $.clock.now())
    return block
      ? next({ ...e, blocks: [...e.blocks, { name: 'learnedRules', text: block }] })
      : next(e)
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'lessons' }, async $ => {
    const { text, context } = await lessonsCmd($)
    return context.length ? { text, context } : { text }
  })

  on('command.run', { command: 'remind' }, async ($, e) => ({
    text: await remindCmd($, String(e.args ?? ''), await $.clock.now()),
  }))
}
