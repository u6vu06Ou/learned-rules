import { test, expect, mock } from 'claude-code/testing'
import {
  backendTag, buildIndex, buildInjection, dateStr, isApplicable, lessonsCmd,
  parseEntries, recordFailure, remindCmd,
} from './lib'
import { register } from './register'

// A hand-rolled host for unit tests: in-memory fs, fixed env and clock —
// the same shape the engine's `$` has for the calls the lib makes.
function unit$(opts: { env?: Record<string, string>; now?: number; files?: Record<string, string> }) {
  const files: Record<string, string> = { ...(opts.files ?? {}) }
  const $: any = {
    env: { get: async (k: string) => opts.env?.[k] },
    clock: { now: async () => opts.now ?? Date.UTC(2026, 9, 17, 6) },
    fs: {
      read: async (p: string) => {
        if (!(p in files)) throw new Error('missing: ' + p)
        return files[p]
      },
      write: async (p: string, t: string) => { files[p] = t },
    },
  }
  return { $, files }
}

const HOME = { HOME: '/home/u', ANTHROPIC_BASE_URL: '' }
const NOW = Date.UTC(2026, 9, 17, 6) // a date with a safe margin in any sane local zone
const RULES = '/home/u/.claude/learned-rules/rules.md'
const UNRESOLVED = '/home/u/.claude/learned-rules/unresolved.md'
const REMINDERS = '/home/u/.claude/learned-rules/reminders.json'

function rule(date: string, title: string, opts: { tag?: string; remedy?: string } = {}) {
  const tag = opts.tag ? ` [${opts.tag}]` : ''
  return [
    `## ${date} ${title}${tag}`,
    '- **condition**: when you do the thing',
    '- **event**: it broke',
    `- **remedy**: ${opts.remedy ?? '(fill in next time you hit this)'}`,
    '',
  ].join('\n')
}

test('backend tag: empty or the official endpoint is official, anything else is proxy', () => {
  expect(backendTag(undefined)).toBe('official')
  expect(backendTag('')).toBe('official')
  expect(backendTag('https://api.anthropic.com')).toBe('official')
  expect(backendTag('http://localhost:8080')).toBe('proxy')
})

test('a tool failure is recorded with tool, input, error and a placeholder remedy', async () => {
  const { $, files } = unit$({ env: HOME, now: NOW })
  const r = await recordFailure($, 'Bash', 'git frobnicate', 'fatal: frobnicate is not a git command (exit 128)', NOW)
  expect(r).toBe('recorded')
  const file = files[UNRESOLVED]!
  expect(file).toContain(`## ${dateStr(NOW)} Bash failed [official]`)
  expect(file).toContain('- **input**: git frobnicate')
  expect(file).toContain('- **error**: fatal: frobnicate is not a git command (exit 128)')
  expect(file).toContain('- **remedy**: (fill in next time you hit this)')
})

test('the same pothole only pads the float once: digits drift, the signature does not', async () => {
  const { $, files } = unit$({ env: HOME, now: NOW })
  await recordFailure($, 'Bash', 'curl x', 'connect to api.internal port 8443 failed after 2047 ms', NOW)
  const r = await recordFailure($, 'Bash', 'curl y', 'connect to api.internal port 443 failed after 9999 ms', NOW)
  expect(r).toBe('duplicate')
  expect(files[UNRESOLVED]!.split(/^## /m).length - 1).toBe(1)
})

test('rules without a real remedy are never injected', async () => {
  const rules = [
    rule('2026-10-01', 'a lesson nobody finished writing'), // placeholder remedy
    rule('2026-10-02', 'check the exit code before parsing json', { remedy: 'stop on non-zero' }),
  ].join('\n')
  const { $ } = unit$({ env: HOME, now: NOW, files: { [RULES]: rules } })
  const out = (await buildInjection($, NOW))!
  expect(out).toContain('check the exit code')
  expect(out).not.toContain('nobody finished writing')
  expect(out).toContain('1 lessons apply')
})

test('rules tagged for the other backend are filtered out', async () => {
  const rules = [
    rule('2026-10-01', 'generic lesson', { remedy: 'do x' }),
    rule('2026-10-02', 'proxy-only lesson', { tag: 'proxy', remedy: 'do y' }),
    rule('2026-10-03', 'official-only lesson', { tag: 'official', remedy: 'do z' }),
  ].join('\n')
  const official = unit$({ env: HOME, now: NOW, files: { [RULES]: rules } })
  const o = (await buildInjection(official.$, NOW))!
  expect(o).toContain('generic lesson')
  expect(o).toContain('official-only lesson')
  expect(o).not.toContain('proxy-only lesson')

  const proxy = unit$({ env: { HOME: '/home/u', ANTHROPIC_BASE_URL: 'http://localhost:8080' }, now: NOW, files: { [RULES]: rules } })
  const q = (await buildInjection(proxy.$, NOW))!
  expect(q).toContain('proxy-only lesson')
  expect(q).not.toContain('official-only lesson')
})

test('a full index budget drops the oldest titles first, not the newest', async () => {
  const oldest = 'older lesson alphaaaaaaaaaaaaaaaaaaaa'
  const newest = 'newest lesson bbbbbbbbbbbbbbbbbbbb'
  const rules = [rule('2026-10-01', oldest, { remedy: 'r1' }), rule('2026-10-02', newest, { remedy: 'r2' })].join('\n')
  const { $ } = unit$({
    env: { ...HOME, LEARNED_RULES_INDEX_BYTES: '60' }, // fits the newest title line, not two
    now: NOW,
    files: { [RULES]: rules },
  })
  const out = (await buildInjection($, NOW))!
  expect(out).toContain('1 older not listed')
  const idx = out.slice(out.indexOf('check this list first.'))
  expect(idx).toContain(newest)
  expect(idx.indexOf('- ' + oldest)).toBe(-1)
})

test('buildIndex counts every dropped older title', () => {
  const blocks = ['## 2026-01-01 one\nx', '## 2026-01-02 two\nx', '## 2026-01-03 three\nx']
  const { index, dropped } = buildIndex(blocks, 24) // room for one line
  expect(index).toBe('- 2026-01-03 three\n')
  expect(dropped).toBe(2)
})

test('remind add, list and done move a reminder through its life', async () => {
  const { $, files } = unit$({ env: HOME, now: NOW })
  expect(await remindCmd($, 'add 2026-10-20 water the office plant', NOW)).toBe('added r001 · due 2026-10-20: water the office plant')
  const stored = JSON.parse(files[REMINDERS]!)
  expect(stored[0]).toMatchObject({ id: 'r001', due: '2026-10-20', done: null })

  const list = await remindCmd($, 'list', NOW)
  expect(list).toContain('[r001] 2026-10-20 waiting — water the office plant')

  expect(await remindCmd($, 'done r001', NOW)).toContain('done r001')
  expect(JSON.parse(files[REMINDERS]!)[0].done).toBe(dateStr(NOW))
  expect(await remindCmd($, 'done r999', NOW)).toContain('no such id')
  expect(await remindCmd($, 'bogus', NOW)).toContain('usage:')
})

test('a due reminder leads the session-start text, above the rules index', async () => {
  const reminders = JSON.stringify([
    { id: 'r001', due: '2026-10-15', text: 're-check the thing from two days ago', added: '2026-10-10', done: null },
    { id: 'r002', due: '2026-12-01', text: 'not due yet', added: '2026-10-10', done: null },
  ])
  const rules = rule('2026-10-01', 'one fine lesson', { remedy: 'r' })
  const { $ } = unit$({ env: HOME, now: NOW, files: { [REMINDERS]: reminders, [RULES]: rules } })
  const out = (await buildInjection($, NOW))!
  expect(out).toContain('🔔 Due reminders (1)')
  expect(out).toContain('[r001] 2026-10-15 (2d overdue): re-check the thing')
  expect(out).not.toContain('not due yet')
  expect(out.indexOf('🔔')).toBeLessThan(out.indexOf('[learned-rules]'))
})

test('no rules and nothing due injects nothing', async () => {
  const { $ } = unit$({ env: HOME, now: NOW })
  expect(await buildInjection($, NOW)).toBeUndefined()
})

test('/lessons reports both counts and hands the agent triage instructions', async () => {
  const rules = [rule('2026-10-01', 'live one', { remedy: 'r' }), rule('2026-10-02', 'half-baked one')].join('\n')
  const { $ } = unit$({ env: HOME, now: NOW, files: { [RULES]: rules, [UNRESOLVED]: rule('2026-10-16', 'Read failed') } })
  const { text, context } = await lessonsCmd($)
  expect(text).toContain('1 unresolved failure')
  expect(text).toContain('1 active rule')
  expect(text).toContain('(2 recorded')
  expect(context[0]).toContain('remedy is mandatory')

  const empty = unit$({ env: HOME, now: NOW })
  const quiet = await lessonsCmd(empty.$)
  expect(quiet.context.length).toBe(0)
})

// The real inject hook, fired the way a real session fires it: core's boot
// assembles the context blocks (userEmail, currentDate, ...) and raises
// `prompt.context` once per conversation; the hook answers the block list the
// first user message carries. The test drives the hook straight out of
// register.ts with the engine's event shape and an in-memory host.
test('the prompt.context hook rides the learned-rules block onto the conversation', async () => {
  const handlers: Record<string, unknown> = {}
  const chainable = { catch: () => chainable } as unknown
  const on = ((name: string, ...rest: unknown[]) => {
    // a plain handler or a gated [match, handler]; keep the last one
    const h = rest[rest.length - 1]
    handlers[name] = h
    return chainable
  }) as unknown as Parameters<typeof register>[0]
  register(on)

  expect(handlers['prompt.context']).toBeDefined()
  const hook = handlers['prompt.context'] as ($: any, e: any, next: any) => Promise<unknown>
  const { $ } = unit$({
    env: HOME,
    now: NOW,
    files: {
      [RULES]: [
        '## 2026-10-01 PURPLE-ELEPHANT lesson',
        '- **condition**: whenever it comes up',
        '- **event**: it bit',
        '- **remedy**: quote PURPLE-ELEPHANT when you see this',
        '',
      ].join('\n'),
      [REMINDERS]: JSON.stringify([
        { id: 'r001', due: '2026-10-01', text: 'ZEBRA-CHECK the expiring thing', added: '2026-09-30', done: null },
      ]),
    },
  })
  const next = async (ev: any) => ev // identity: the block list stands as answered
  const out = (await hook($, { blocks: [{ name: 'userEmail', text: 'someone@example.com' }] }, next)) as any
  const learned = out.blocks.find((b: any) => b.name === 'learnedRules')
  expect(learned).toBeDefined()
  expect(learned.text).toContain('ZEBRA-CHECK')
  expect(learned.text).toContain('PURPLE-ELEPHANT')
  expect(learned.text).toContain('🔔 Due reminders (1)')
  // core's own blocks ride through untouched
  expect(out.blocks[0]).toMatchObject({ name: 'userEmail' })

  // nothing worth saying passes core's list through unchanged
  const empty = unit$({ env: HOME, now: NOW }).$
  const quiet = (await hook(empty, { blocks: [] }, next)) as any
  expect(quiet.blocks).toMatchObject([])
})

// Through the engine: the plugin's `tool.call` hook sees the failure the
// (mocked) call beneath it reported, and writes the review file.
test('a failing tool call through the engine is recorded once', async ($, on) => {
  mock.env(on, { HOME: 'C:/home/u', ANTHROPIC_BASE_URL: '' })
  const clock = mock.clock(on)
  const files: Record<string, string> = {}
  // Engine-call mocks answer with `{ value }`; a throw reads as "call failed"
  // (the lib treats that as a missing file).
  on('fs.read', async (_: any, e: any) => { throw new Error('missing: ' + e.path) })
  on('fs.write', (_: any, e: any) => { files[e.path] = e.text; return { value: undefined } })
  on('tool.call', () => ({ result: undefined, text: 'spawn frobnicate ENOENT (code 2)', isError: true }))

  const r = await $.tool.call({ tool: 'Bash', command: 'frobnicate --now' })
  expect(r.isError).toBe(true)
  // The engine normalizes the path it passes to fs mocks (backslashes), so
  // look the write up by its normalized form.
  const key = Object.keys(files).find(k => k.replace(/\\/g, '/') === 'C:/home/u/.claude/learned-rules/unresolved.md')
  const file = files[key!]!
  expect(file).toContain('Bash failed [official]')
  expect(file).toContain('- **input**: frobnicate --now')
  expect(file).toContain('spawn frobnicate ENOENT (code 2)')
  expect(file).toContain(`## ${dateStr(clock.now())} `)
})
