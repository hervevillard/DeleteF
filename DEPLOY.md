# Deploying & Using DeleteF

## Install (temporary, unsigned)

1. Open Firefox and go to `about:debugging`.
2. Click **This Firefox** in the left sidebar.
3. Click **Load Temporary Add-on…**.
4. Select the `manifest.json` file in this project folder.
5. The DeleteF icon appears in the toolbar. (Temporary add-ons are removed when Firefox
   restarts — repeat these steps to reload.)

## (Optional) Enable the DeepSeek AI fallback

The extension works fully without this. Enable it only if you want automatic recovery when
Facebook changes its UI.

1. Go to `about:addons` → **Extensions** → **DeleteF** → **Preferences** (the **⋯** menu →
   Manage → Preferences). Or from `about:debugging`, the options page is listed too.
2. Set **Enable AI fallback** to **On**.
3. Paste your **DeepSeek API key** (`sk-...`).
4. Choose a **model** — `deepseek-chat` (fast, cheap) is recommended.
5. Click **Save**.

> ⚠️ With AI enabled, a **redacted** page structure (tags/roles/aria-labels only — no
> contact names or message text) is sent to DeepSeek **only when a selector fails**. Leave
> it Off for zero network calls.

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
  - Enable the **AI fallback** (above) so DeepSeek locates the buttons automatically.
- **"AI unavailable" / "No DeepSeek API key set":** Open Preferences, enable AI, and save a
  valid key. Check the key has quota/credit.
- **"DeepSeek HTTP 401/402/429":** 401 = bad key, 402 = no balance, 429 = rate-limited.
  Fix the key/credit or wait and retry.
- **Stops after a few deletes / nothing happens:** Facebook may be rate-limiting. Wait a few
  minutes and Start again. Increase the delays in `content.js` (`jitter(800, 1500)`).
- **Verify it loaded:** In `about:debugging` → This Firefox, find DeleteF and click
  **Inspect** to view the background/content console for errors.
