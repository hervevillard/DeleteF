# Deploying & Using DeleteF

## Install (temporary, unsigned)

1. Open Firefox and go to `about:debugging`.
2. Click **This Firefox** in the left sidebar.
3. Click **Load Temporary Add-on…**.
4. Select the `manifest.json` file in this project folder.
5. The DeleteF icon appears in the toolbar. (Temporary add-ons are removed when Firefox
   restarts — repeat these steps to reload.)

## (Optional) Enable the DeepSeek AI mode

The extension works fully without this. Enable it only if you want the agent to delete
*selectively* (e.g. "delete everyone except Mom") based on the instruction box.

Everything is in the **panel** — there is no separate settings page:

1. Click the **DeleteF** toolbar icon to open the panel.
2. Tick **Use AI (DeepSeek)**.
3. Paste your **DeepSeek API key** (`sk-...`) in the field that appears (👁 toggles visibility).
4. Choose a **model** — `deepseek-chat` (fast, cheap) is recommended.

Settings save automatically as you change them (stored in `browser.storage.local`).

> ⚠️ With AI on, the agent reads the conversation list, so **real contact names and visible
> text are sent to DeepSeek** to decide who to delete. Leave it off for zero network calls
> and nothing leaving your browser.

## Use

1. Go to `https://www.facebook.com/messages` and make sure you are logged in.
2. Click the **DeleteF** toolbar icon — a panel appears top-right.
   The panel shows whether the AI fallback is ON or off.
3. Click **Start**, read the warning, and confirm.
4. Watch progress in the panel. Click **Stop** at any time to halt before the next delete.

> ⚠️ Deletion is permanent. Test on a throwaway/secondary account first if unsure.

## Troubleshooting

- **Panel doesn't appear:** Make sure the URL is under `facebook.com/messages`. Reload the
  page, then click the toolbar icon. Check the toolbar button isn't hidden in the overflow (»).
- **"Could not find the More (⋯) menu" / stops immediately:** Facebook likely changed its
  markup or your UI isn't in English. Two fixes:
  - Open `content.js` and update the `LABELS` strings to match the wording you see, then
    reload the add-on in `about:debugging`; **or**
  - Or, if the wording just shifted, the human-paced clicker retries the confirm step once
    automatically; persistent failures usually mean the `LABELS` need updating.
- **"AI on — but no API key set" / "No DeepSeek API key set":** Tick **Use AI** in the panel
  and paste a valid key in the field that appears. Check the key has quota/credit.
- **"DeepSeek HTTP 401/402/429":** 401 = bad key, 402 = no balance, 429 = rate-limited.
  Fix the key/credit or wait and retry.
- **Stops after a few deletes / nothing happens:** Facebook may be rate-limiting. Wait a few
  minutes and Start again. Increase the inter-deletion delay in `content.js`
  (`jitter(1500, 3500)` in `runLoop`).
- **Verify it loaded:** In `about:debugging` → This Firefox, find DeleteF and click
  **Inspect** to view the background/content console for errors.
