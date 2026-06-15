# DeleteF — Agentic AI + CSV Export Design

**Date:** 2026-06-15
**Status:** Approved for planning

## Summary

Two changes to the DeleteF Firefox extension:

1. **CSV export** — a panel button that downloads the names of currently-loaded
   conversations as a CSV. Fully local: no AI, no network, no new permissions.
2. **Agentic AI** — replace the current one-shot "return a CSS selector" AI path
   with a tool-calling agent loop. When AI is enabled, DeepSeek drives the whole
   job through a small set of tools the extension executes against the DOM:
   self-correcting on failure, deleting by natural-language criteria, and running
   end-to-end autonomously after a single upfront confirmation.

The AI-off path stays exactly as it is today: local heuristics only, private,
default.

## Decisions (from brainstorming)

- **AI on = agentic mode.** The old redacted one-shot `ASK_AI` selector path is
  removed and replaced by the agent loop.
- **AI off = heuristic mode.** Unchanged, local-only, the default.
- **Privacy:** in agentic mode, real contact names and visible text MAY be sent to
  DeepSeek. This is an explicit, opt-in tradeoff. Privacy-sensitive users keep AI
  off (heuristics never touch the network).
- **Autonomy:** confirm once upfront, then run unattended. No per-deletion prompts.
- **Selective deletion:** criteria come from a free-text instruction box in the
  panel. Empty = "delete all conversations."
- **CSV:** names only, currently-loaded rows (no auto-scroll).

## Architecture

The LLM cannot see or click the page itself. "Agentic" means a tool-calling loop
where the extension is the model's hands and eyes:

- **`content.js`** owns the loop and the DOM. It holds the tool *schemas* and the
  tool *executors*, runs the turn-by-turn loop, and dispatches each tool call to a
  DOM action.
- **`background.js`** owns the network (Facebook's CSP blocks cross-origin fetch
  from content scripts). It becomes a dumb proxy: a new `AGENT_TURN` message carries
  `{messages, tools}`, it calls DeepSeek `chat/completions` with tool support, and
  returns the raw assistant message (`content` + `tool_calls`) or `{error}`.

### Loop

```
messages = [ system_prompt, user_message(instruction) ]
for i in 0..MAX_ITERATIONS while state.running:
    resp = sendMessage({ type: 'AGENT_TURN', payload: { messages, tools } })
    if resp.error: log(resp.error); stop; return
    assistant = resp.message
    messages.push(assistant)
    if assistant.tool_calls:
        for tc in assistant.tool_calls:
            result = executeTool(tc.function.name, parseArgs(tc.function.arguments))
            messages.push({ role: 'tool', tool_call_id: tc.id,
                            content: JSON.stringify(result) })
    else:
        log(assistant.content)   // final summary, no more tool calls
        break
```

- `MAX_ITERATIONS` ~= 100, a runaway/cost backstop.
- `state.running` is checked before every turn; the Stop button sets it false and
  the loop exits cleanly between turns.

### System prompt

Describes the agent's role (delete Facebook Messenger conversations), the available
tools, the autonomy contract (already confirmed by the user; do not ask again), and
how to interpret the user's instruction (empty = delete all; otherwise apply the
criteria, using `list_conversations` names to decide). Instructs it to call `finish`
with a short summary when done.

## Tools

| Tool | Arguments | Action | Returns |
|------|-----------|--------|---------|
| `list_conversations` | none | Stamp a stable `data-df-id` on each currently-loaded row; collect them | `{ conversations: [{ id, name }] }` |
| `delete_conversation` | `{ id }` | Find row by `data-df-id`; run the shared `performDelete(row)` (3-step heuristic delete) | `{ status: "deleted" \| "no_delete_option" \| "error", detail, menuItemsSeen? }` |
| `scroll_conversation_list` | none | Scroll the chat list container to load more virtualized rows; wait briefly | `{ loadedCount }` |
| `observe` | none | Serialize the currently-open menu/dialog (or the list if none open) WITH visible text, tagging each element `data-df="N"` | `{ structure }` |
| `click_element` | `{ df }` | Click the element tagged `data-df="df"` from the most recent `observe` | `{ ok: boolean }` |
| `finish` | `{ summary }` | End the run | `{ done: true }` |

- `delete_conversation` is the workhorse: it serves selective deletion (model
  chooses which `id`s) and autonomy. On failure it returns rich detail
  (`menuItemsSeen`) so the model can decide to retry, skip, or self-correct.
- `observe` + `click_element` are the self-correction escape hatch for unexpected
  dialogs or when `delete_conversation` cannot find an element. `observe` keeps an
  internal reference to the root it tagged so `click_element` resolves `data-df`
  against the same subtree.

### Stable row identity

`list_conversations` stamps each row with a session-persistent `data-df-id="N"`
(monotonic counter). `delete_conversation(id)` resolves the row via
`[data-df-id="N"]`. Deleted rows simply stop appearing in later
`list_conversations` results; indices never shift under the model.

## Shared deletion path

Extract the current 3-step deletion (open ⋯ menu → click "Delete chat" → confirm)
out of `deleteOne()` into a reusable `performDelete(row)`. Both the heuristic
`runLoop()` (AI off) and the `delete_conversation` tool (AI on) call it, so the
actual clicking has a single, already-working code path. `performDelete` throws
typed-enough errors (no-delete-option vs. other) that callers map to status/skip.

## CSV export

- **Pure helpers (in `lib/dom-helpers.js`, unit-tested):**
  - `nameFromAriaLabel(label)` — strips a leading `"More options for "`
    (case-insensitive), returns the trimmed remainder or `""`.
  - `toCsv(rows)` — takes `[{ name }]`, returns an RFC-4180 CSV string with a
    `Name` header; quotes fields containing `"`, `,`, `\n`, or `\r` and doubles
    embedded quotes.
- **`content.js` `downloadCsv()`:** `findAllRows()` → for each row derive a name
  (the ⋯ button's `aria-label` via `nameFromAriaLabel`, falling back to the row's
  link text) → `toCsv` → `Blob` → temporary `<a download="deletef-conversations.csv">`
  click → revoke. No `downloads` permission required.
- **Panel:** a "Download CSV" button, enabled regardless of AI setting or run state.

## Panel UI

`buildPanel()` adds, above the log:
- A **textarea** "Instructions (optional)" — placeholder explains it only applies in
  AI mode and that empty means delete all.
- A **"Download CSV"** button wired to `downloadCsv()`.

`onStart()`:
- Reads the AI setting via `refreshAiStatus()`.
- Shows the upfront `window.confirm`. In AI mode the message includes the instruction
  text (or "ALL conversations" when empty).
- AI on → `runAgent(instructionText)`. AI off → existing `runLoop()`.

## Error handling

- Tool executor throws → caught, returned to the model as `{ status: "error",
  detail }`; the loop continues so the model can react.
- API/network error from `AGENT_TURN` → log it, stop the run.
- Malformed tool arguments → return an error result, do not crash the loop.
- `MAX_ITERATIONS` reached → stop with a clear log message.
- Stop button → `state.running = false`; loop exits before the next turn.

## Testing

`lib/dom-helpers.js` remains the unit-tested surface (Node + jsdom):
- `toCsv` — header, empty input, fields needing quoting, embedded quotes/commas/
  newlines.
- `nameFromAriaLabel` — strips prefix, case-insensitive, handles missing/empty.
- `redactStructure` — new `includeText` option keeps trimmed text content; default
  (text-free) behavior unchanged.

The agent loop, tool dispatch, and `performDelete` require a browser and stay
manually verified, consistent with the current project (`content.js` /
`background.js` are not unit-tested).

## Docs to update

- `options.html` — revise the privacy copy: when AI is on, the extension now runs an
  agent that may send real names/text to DeepSeek; AI off remains zero-network.
- `CLAUDE.md` — update the "Key design constraints" section: the AI path is now an
  agentic tool-calling loop, not a one-shot selector call. Document the tool set and
  the shared `performDelete` path.

## Out of scope (YAGNI)

- Auto-scroll for CSV (chosen: loaded rows only).
- Per-deletion confirmation, dry-run preview (chosen: confirm once).
- Provider abstraction beyond DeepSeek.
- Redacted/structure-only mode *with* AI on — privacy users use AI-off heuristics.
