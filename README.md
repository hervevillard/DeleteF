# DeleteF — Facebook Messages Bulk Deleter (Firefox)

Deletes **all conversation threads** from `facebook.com/messages` by automating
Facebook's own UI: for each conversation it opens the "⋯" menu, clicks **Delete chat**,
and confirms. Controlled by an on-page panel with **Start**/**Stop** and live progress.

## What "delete" means here

This performs Facebook's **Delete chat**, which removes the conversation **from your
view**. It is **permanent and cannot be undone**. It does not "unsend" messages for the
other person.

## How it works

- Manifest V3 Firefox extension, no build step.
- `content.js` injects a floating panel and runs the deletion loop on `facebook.com/messages`.
- `background.js` toggles the panel when you click the toolbar button, and is the only
  place that makes network calls (the optional AI fallback below).
- `lib/dom-helpers.js` holds pure, unit-tested helpers (`jitter`, `matchByText`,
  `waitFor`, `resolveSelector`, `redactStructure`, `parseSelectorResponse`).
- Element matching prefers ARIA roles/labels and visible text over CSS class names, so it
  survives Facebook's frequent markup changes. All match strings live in the `LABELS`
  object at the top of `content.js`.

### Optional: DeepSeek Agentic Mode

By default the extension makes **no network calls at all**. You can optionally enable
**AI mode** so DeepSeek runs a tool-calling agent that drives deletion end-to-end
(including selective deletion from your instruction text).

When AI is on:

1. `content.js` runs an agent loop with tools (`list_conversations`,
  `delete_conversation`, `scroll_conversation_list`, `observe`, `click_element`,
  `finish`).
2. `background.js` proxies each model turn to DeepSeek's OpenAI-compatible API
  (`https://api.deepseek.com/chat/completions`) because Facebook CSP blocks
  cross-origin fetches from content scripts.
3. The model may receive conversation names and visible UI text so it can decide
  what to delete and recover from UI changes.

Enable it on the extension's **Settings** page (Add-ons Manager → DeleteF → Preferences),
where you paste your DeepSeek API key and pick a model (`deepseek-chat` recommended). The
key is stored in `browser.storage.local` on your machine and is only sent to DeepSeek.

> AI mode is **off** unless you turn it on AND provide a key.

## Data & privacy

- With AI **off** (default): the extension sends data to **no one**.
- With AI **on**: conversation names and visible UI text can be sent to DeepSeek so the
  agent can decide what to delete and recover from failures.

## Risks & limitations

- **Irreversible:** deleted conversations cannot be recovered.
- **Terms of Service:** automating Facebook may violate Meta's ToS and could risk account
  flagging. Use on your own account, at your own risk.
- **Fragile:** if Facebook changes its UI, update the `LABELS` strings in `content.js`
  (or enable the AI fallback to recover automatically).
- **English UI:** defaults assume English ("Delete chat" / "Delete").
- **Temporary install:** removed when Firefox restarts (see DEPLOY.md).

## Development

```bash
npm install   # installs jsdom (dev only)
npm test      # runs the unit tests for lib/dom-helpers.js
```

See [DEPLOY.md](DEPLOY.md) for install and usage.

## Project layout

| File | Responsibility |
|------|----------------|
| `manifest.json` | MV3 manifest: action button, content scripts, options page, permissions |
| `background.js` | Toggles panel; calls DeepSeek for the AI fallback |
| `content.js` | `LABELS` config, panel injection, deletion loop, AI fallback wiring |
| `lib/dom-helpers.js` | Pure, tested helpers |
| `panel.css` | Control-panel styling |
| `options.html` / `options.js` | AI-fallback settings (key, model, on/off) |
| `icons/` | Toolbar icons |
| `test/dom-helpers.test.js` | Unit tests |
| `docs/superpowers/` | Design spec and implementation plan |
