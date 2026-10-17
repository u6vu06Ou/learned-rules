// learned-rules: pure logic. Everything here takes a minimal `$`-shaped host
// ({ env, clock, fs }) so tests can drive it without a running engine.
// The mod never makes a model call; every byte below is computed locally.

export const PLACEHOLDER = /\*\*remedy\*\*:\s*\(fill in/i
export const DEFAULT_INDEX_BYTES = 4096 // title index, UTF-8 bytes
export const DEFAULT_DETAIL_BYTES = 1400 // newest rule, in full

export type BackendTag = 'official' | 'proxy'

export type Paths = { dir: string; rules: string; unresolved: string; reminders: string }

export type Reminder = { id: string; due: string; text: string; added: string; done: string | null }

export function backendTag(base: string | undefined): BackendTag {
  const b = (base ?? '').trim()
  return (!b || /api\.anthropic\.com/i.test(b)) ? 'official' : 'proxy'
}

export async function currentTag($: any): Promise<BackendTag> {
  return backendTag(await $.env.get('ANTHROPIC_BASE_URL'))
}

export async function paths($: any): Promise<Paths | undefined> {
  const home = (await $.env.get('HOME')) || (await $.env.get('USERPROFILE'))
  if (!home) return undefined
  const dir = home.replace(/\\/g, '/').replace(/\/+$/, '') + '/.claude/learned-rules'
  return { dir, rules: dir + '/rules.md', unresolved: dir + '/unresolved.md', reminders: dir + '/reminders.json' }
}

// Dedupe signature: collapse whitespace, mask every run of digits — between
// repeats of the SAME failure what drifts is exactly the numbers (PIDs, ports,
// timestamps) and the whitespace.
export function norm(s: string): string {
  return s.replace(/\s+/g, ' ').replace(/\d+/g, '#').trim()
}

export function signature(error: string): string {
  return norm(error).slice(0, 60)
}

const byteLen = (s: string) => new TextEncoder().encode(s).length

export function truncateBytes(s: string, budget: number): string {
  if (byteLen(s) <= budget) return s
  // Slice by bytes, decode back; a cut mid-character loses only the tail glyph.
  const cut = new TextDecoder().decode(new TextEncoder().encode(s).slice(0, budget))
  return cut + ' …(truncated)'
}

export function dateStr(ms: number): string {
  const d = new Date(ms)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

// A short summary of a tool call's arguments: the first well-known string
// field, else the whole call as compact JSON.
export function inputSummary(e: any): string {
  const KEYS = ['command', 'file_path', 'filePath', 'path', 'pattern', 'url', 'query', 'prompt', 'description']
  for (const k of KEYS) {
    const v = e?.[k]
    if (typeof v === 'string' && v) return v.replace(/\s+/g, ' ').slice(0, 150)
  }
  let s = ''
  try {
    s = JSON.stringify(e, (k, v) => (k === 'tool' || k === 'tool_use_id' || k === 'agentId' || k === 'requestMeta' ? undefined : v)) ?? ''
  } catch {}
  return s.replace(/\s+/g, ' ').slice(0, 150)
}

async function readOr($: any, path: string, fallback = ''): Promise<string> {
  try {
    return await $.fs.read(path)
  } catch {
    return fallback
  }
}

// Append one failure to the review file, or 'duplicate' when the same pothole
// (same masked signature) is already recorded. Returns 'recorded' | 'duplicate'
// | 'no-home'; never throws, so a broken recorder can never break the call.
export async function recordFailure($: any, tool: string, input: string, error: string, now: number): Promise<string> {
  const p = await paths($)
  if (!p) return 'no-home'
  const flat = error.replace(/\s+/g, ' ').trim().slice(0, 300) || '(no error text captured)'
  const sig = signature(flat)
  const existing = await readOr($, p.unresolved)
  if (sig.length >= 12 && norm(existing).includes(sig)) return 'duplicate'
  const entry = [
    '',
    `## ${dateStr(now)} ${tool} failed [${await currentTag($)}]`,
    `- **tool**: ${tool}`,
    `- **input**: ${input || '(none)'}`,
    `- **error**: ${flat}`,
    '- **remedy**: (fill in next time you hit this)',
    '',
  ].join('\n')
  try {
    await $.fs.write(p.unresolved, existing + entry)
  } catch {
    return 'write-failed'
  }
  return 'recorded'
}

// --- rules.md parsing -------------------------------------------------------

// Split into '## ...' blocks; any preamble before the first heading is file
// commentary, not a lesson.
export function parseEntries(content: string): string[] {
  return content.split(/\n(?=## )/).filter(b => /^## /.test(b))
}

// A rule applies to this backend when its remedy is really filled in and its
// title carries either no tag or this backend's tag ([official] / [proxy]).
export function isApplicable(block: string, tag: BackendTag): boolean {
  if (PLACEHOLDER.test(block)) return false
  const cut = block.indexOf('\n')
  const head = cut === -1 ? block : block.slice(0, cut)
  return !head.includes('[' + (tag === 'official' ? 'proxy' : 'official') + ']')
}

// Title index, newest last (recency reads as "most likely to bite again").
// Walk backwards from the newest title, prepending, until the byte budget is
// spent; everything older counts as dropped — the OLD entries fall off first.
export function buildIndex(blocks: string[], budget: number): { index: string; dropped: number } {
  const titles = blocks.map(b => {
    const cut = b.indexOf('\n')
    return (cut === -1 ? b : b.slice(0, cut)).replace(/^##\s*/, '').trim()
  })
  let index = ''
  let dropped = 0
  for (let i = titles.length - 1; i >= 0; i--) {
    const next = '- ' + titles[i] + '\n'
    if (byteLen(index + next) > budget) { dropped = i + 1; break }
    index = next + index
  }
  return { index, dropped }
}

function intEnv(v: string | undefined, dflt: number): number {
  const n = Number.parseInt(v ?? '', 10)
  return n > 0 ? n : dflt
}

// --- reminders --------------------------------------------------------------

export async function loadReminders($: any, path: string): Promise<Reminder[]> {
  const s = await readOr($, path)
  if (!s.trim()) return []
  try {
    const v = JSON.parse(s)
    return Array.isArray(v) ? v : []
  } catch {
    return []
  }
}

export async function saveReminders($: any, path: string, items: Reminder[]): Promise<void> {
  await $.fs.write(path, JSON.stringify(items, null, 2) + '\n')
}

export function nextId(items: Reminder[]): string {
  let n = 0
  for (const r of items) {
    const m = /^r(\d+)$/.exec(r.id)
    if (m) n = Math.max(n, Number(m[1]))
  }
  return 'r' + String(n + 1).padStart(3, '0')
}

export function dueReminders(items: Reminder[], today: string): Reminder[] {
  return items.filter(r => !r.done && r.due <= today).sort((a, b) => a.due.localeCompare(b.due))
}

function overdueDays(today: string, due: string): number {
  return Math.round((Date.parse(today) - Date.parse(due)) / 86_400_000)
}

export async function remindCmd($: any, args: string, now: number): Promise<string> {
  const p = await paths($)
  if (!p) return 'learned-rules: no home directory found (HOME/USERPROFILE unset)'
  const usage = 'usage: /remind add YYYY-MM-DD <text> · /remind list · /remind done <id>'
  const m = /^(add|list|done)\b([\s\S]*)$/.exec(args.trim())
  if (!m) return usage
  const items = await loadReminders($, p.reminders)

  if (m[1] === 'add') {
    const a = /^(\d{4}-\d{2}-\d{2})\s+([\s\S]+)$/.exec(m[2].trim())
    if (!a || Number.isNaN(Date.parse(a[1]))) return 'remind: need a date and text — ' + usage
    const id = nextId(items)
    items.push({ id, due: a[1], text: a[2].replace(/\s+/g, ' ').trim(), added: dateStr(now), done: null })
    await saveReminders($, p.reminders, items)
    return `added ${id} · due ${a[1]}: ${items[items.length - 1].text}`
  }

  if (m[1] === 'list') {
    if (!items.length) return 'no reminders yet — add one with /remind add YYYY-MM-DD <text>'
    const today = dateStr(now)
    return [...items].sort((a, b) => a.due.localeCompare(b.due))
      .map(r => {
        const late = r.done ? '' : overdueDays(today, r.due)
        const mark = r.done ? 'done' : r.due <= today ? `DUE${late > 0 ? ` (${late}d overdue)` : ''}` : 'waiting'
        return `[${r.id}] ${r.due} ${mark} — ${r.text}`
      }).join('\n')
  }

  // done
  const id = m[2].trim()
  const hit = items.find(r => r.id === id)
  if (!hit) return `remind: no such id: ${id || '(missing)'} — see /remind list`
  hit.done = dateStr(now)
  await saveReminders($, p.reminders, items)
  return `done ${hit.id}: ${hit.text}`
}

// --- session-start injection ------------------------------------------------

// The text appended to a new conversation's context: due reminders first
// (they must be said out loud), then the rules title index and the newest
// rule in full. undefined when there is nothing to say.
export async function buildInjection($: any, now: number): Promise<string | undefined> {
  const p = await paths($)
  if (!p) return undefined
  const tag = await currentTag($)
  const today = dateStr(now)

  const due = dueReminders(await loadReminders($, p.reminders), today)
  const rulesText = await readOr($, p.rules)
  const all = parseEntries(rulesText)
  const kept = rulesText.trim() ? all.filter(b => isApplicable(b, tag)) : []
  if (!due.length && !kept.length) return undefined

  let out = ''
  if (due.length) {
    const lines = due.map(r => {
      const late = overdueDays(today, r.due)
      return `- [${r.id}] ${r.due}${late > 0 ? ` (${late}d overdue)` : ''}: ${r.text}`
    })
    out += `🔔 Due reminders (${due.length}): mention them in your first reply; mark each done with /remind done <id>.\n` + lines.join('\n') + '\n\n'
  }
  if (kept.length) {
    const indexBudget = intEnv(await $.env.get('LEARNED_RULES_INDEX_BYTES'), DEFAULT_INDEX_BYTES)
    const detailBudget = intEnv(await $.env.get('LEARNED_RULES_DETAIL_BYTES'), DEFAULT_DETAIL_BYTES)
    const { index, dropped } = buildIndex(kept, indexBudget)
    const detail = truncateBytes(kept[kept.length - 1].trim(), detailBudget)
    out += `[learned-rules] ${kept.length} lessons apply to this backend [${tag}]` +
      (dropped ? `; ${dropped} older not listed` : '') + ` (${all.length} recorded).\n` +
      'This is a title index, not the full text. To read a rule in full:\n' +
      `  grep -A8 "<keyword from its title>" ${p.rules}\n` +
      'When a tool call fails, or the same approach fails twice, check this list first.\n\n' +
      index + '\n[Most recent lesson, in full]\n' + detail
  }
  return out
}

// --- /lessons ---------------------------------------------------------------

export async function lessonsCmd($: any): Promise<{ text: string; context: string[] }> {
  const p = await paths($)
  if (!p) return { text: 'learned-rules: no home directory found (HOME/USERPROFILE unset)', context: [] }
  const tag = await currentTag($)
  const un = parseEntries(await readOr($, p.unresolved)).length
  const rules = parseEntries(await readOr($, p.rules))
  const active = rules.filter(b => isApplicable(b, tag)).length
  const text = `learned-rules: ${un} unresolved failure${un === 1 ? '' : 's'} in ${p.unresolved}` +
    ` · ${active} active rule${active === 1 ? '' : 's'} in ${p.rules} (${rules.length} recorded, backend tag [${tag}])`
  const context = un > 0
    ? [`Triage ${p.unresolved}: for each entry worth keeping, rewrite it into ${p.rules} as ` +
       `'## <date> <title> [<tag>]'` +
       ` with - **condition** / - **event** / - **remedy** lines. A remedy is mandatory: an entry with the ` +
       `placeholder remedy is never injected. Then delete the entries you processed from the unresolved file. ` +
       `Skip entries that teach nothing.`]
    : []
  return { text, context }
}
