# learned-rules

A Claude Code plugin that learns from the tool failures it actually witnesses: every errored tool call is journaled locally, a human (or the agent, on request) distills the worthwhile ones into a curated rules file, and every new conversation starts with a compact index of the lessons — plus any dated reminders that have come due.

## Why

An agent that trips on the same pothole in session after session is expensive and annoying. learned-rules splits the problem in two: **capture** is fully automatic and mechanical (a journal line per real tool failure), and **curation** is deliberate (a rule only exists once someone writes down what to do instead). Only curated rules are ever injected, and only as a budgeted title index — so a hundred lessons cost a couple of kilobytes of context, not a hundred full stories.

## Install

At a Claude Code prompt:

```
/plugin install learned-rules --marketplace u6vu06Ou/learned-rules
```

(Answer `y` to add the marketplace, then pick the user scope.)

## What it does

- **Failure capture**: when a tool call comes back with an error, one entry is appended to `~/.claude/learned-rules/unresolved.md` — date, backend tag, tool name, a 150-character input summary and a 300-character, single-line error. The same pothole is recorded once: two entries whose errors match after whitespace is collapsed and every run of digits is masked count as duplicates, so ports, PIDs and timestamps drifting between repeats never re-pad the file. Purely local; no model call is ever made.
- **Session-start injection**: each new conversation's context gets one extra block (provided something is worth saying): due reminders first, then the title index of the applicable rules from `~/.claude/learned-rules/rules.md` — newest last, and when the byte budget runs out the *oldest* titles drop off first — and the single newest rule in full, as a worked example. The block also tells the agent how to pull any rule's full text (`grep -A8 "<keyword>" <rules file>`). A rule enters the index only when its **remedy is actually written** — a placeholder remedy means the lesson was never finished and it stays out. Titles tagged `[official]` or `[proxy]` apply only to that backend (the tag is decided from `ANTHROPIC_BASE_URL`); untagged rules apply everywhere.
- **`/lessons`**: prints both counts — unresolved failures waiting for triage, active rules for this backend — and, while any failure is untriaged, hands the agent hidden instructions for the triage: rewrite the worthwhile entries into `rules.md` format (remedy mandatory), then delete them from the journal.
- **`/remind`**: dated reminders for anything worth revisiting later.
  ```
  /remind add 2027-03-01 re-check the plugin's eval numbers
  /remind list
  /remind done r001
  ```
  Reminders live in `~/.claude/learned-rules/reminders.json`; at conversation start, anything due (or overdue, with the day count) is listed at the very top of the injected block with a 🔔. Nothing ever runs a shell command on your behalf when a reminder fires — the mod has no auto-exec, by design.
- **Fail open**: if the plugin itself throws, hooks pass through unchanged — a broken recorder never blocks a tool call, and a broken injector never garbles a conversation's context.

## The rules file format

One `##` block per rule; a heading line, then the three fields:

```
## 2026-09-30 git log --since=<date> with no time of day returns 0 commits [official]
- **condition**: checking "did this repo change in the last N days" with `git log --since=2026-09-27`.
- **event**: the bare date silently matched nothing; `--since='2026-09-27 00:00:00'` on the same repo listed plenty. A "zero commits" conclusion drawn from the first form is wrong.
- **remedy**: always give `--since` a full timestamp; cross-check a "nothing happened" conclusion with an independent signal (`git for-each-ref --sort=-committerdate`, file mtimes) before reporting it.
```

`[official]` / `[proxy]` on the heading limits a rule to one backend; no tag means generic. The remedy is the whole point — an entry whose remedy is still the placeholder is never injected.

## Where the files live

Everything sits under the user's home directory; no path is hardcoded:

| File | Holds |
|---|---|
| `~/.claude/learned-rules/unresolved.md` | The mechanical failure journal (to triage) |
| `~/.claude/learned-rules/rules.md` | The curated rules (injected) |
| `~/.claude/learned-rules/reminders.json` | Dated reminders |

## Tuning

| Env var | Default | Meaning |
|---|---|---|
| `LEARNED_RULES_INDEX_BYTES` | `4096` | UTF-8 byte budget for the injected title index (older titles drop first) |
| `LEARNED_RULES_DETAIL_BYTES` | `1400` | UTF-8 byte budget for the one full rule shown |

## How it differs from claude-reflect

[claude-reflect](https://github.com/hubartwork/claude-reflect) learns from *user corrections* — when you tell the agent it did something wrong, it distills that into `CLAUDE.md`. learned-rules instead watches *the tools* and journals calls that really errored, no user input needed. Two further differences by design: only a title index is injected (a growing rule count does not grow the context cost — claude-reflect appends full rules to `CLAUDE.md`), and a rule never takes effect until its remedy is written. The two answer different signals and can run side by side. (The comparison above describes each plugin's documented behavior; any combined-context-size benefit is a design goal, not a measured result.)

## License

MIT — see [LICENSE](LICENSE).

---

## 繁中速覽

# learned-rules

Claude Code 外掛：把親眼看到的工具失敗學起來。失敗當下機械式記一筆到待整理檔（同一個坑只記一次：錯誤訊息壓縮空白、遮住數字後算簽名去重）；之後由人或 agent 把值得的條目整理成正式規則，**remedy（解法）沒寫＝永不注入**。每個新對話開場注入「標題目錄」而不是全文——規則再多也只佔固定預算（預設 4 KB，塞不下從最舊的開始砍）＋最新一條全文示範；目錄裡看到像今天會踩的，agent 再自己 grep 撈全文。標題帶 `[official]`／`[proxy]` 的規則只對那種後端生效，沒 tag 的通用。

安裝（在 Claude Code 對話框輸入）：

```
/plugin install learned-rules --marketplace u6vu06Ou/learned-rules
```

指令：`/lessons` 看「待整理幾條／生效幾條」，有待整理時順便給 agent 整理指示（改寫進 rules.md、remedy 必填、處理完從待整理檔刪掉）。`/remind add 2027-03-01 要回頭看的事` 登記到期提醒，`/remind list`、`/remind done <id>`；到期的會在新對話開場最上面用 🔔 列出（含過期天數）。安全考量：到期**不會**自動跑任何指令，只會提示。

檔案都在家目錄下：`~/.claude/learned-rules/{unresolved.md, rules.md, reminders.json}`，路徑全部動態算、沒有寫死。純本地運作、零模型呼叫；外掛自己出錯一律放行，不擋工具呼叫也不弄壞注入。

和 claude-reflect 的差別：它記「使用者糾正」寫進 CLAUDE.md；本 mod 記「工具真的失敗」，只注入標題目錄，remedy 必填才生效。兩者訊號不同、可並用（以上為設計目的，合體效果未實測）。

授權 MIT。
