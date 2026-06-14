// DeleteF background service worker.
//   1. On toolbar-button click → tell the content script to toggle the panel.
//   2. Handle ASK_AI messages → call DeepSeek (OpenAI-compatible) and return a CSS
//      selector. The fetch lives here (not the content script) because Facebook's
//      page CSP blocks cross-origin requests from content scripts.
'use strict';

const DEEPSEEK_URL = 'https://api.deepseek.com/chat/completions';

// Toggle the panel when the toolbar icon is clicked.
browser.action.onClicked.addListener(async (tab) => {
  if (!tab || !tab.id) return;
  try {
    await browser.tabs.sendMessage(tab.id, { type: 'TOGGLE_PANEL' });
  } catch (err) {
    console.warn('DeleteF: open https://www.facebook.com/messages first.', err);
  }
});

// Ask DeepSeek which element to click, given a redacted structure snapshot.
// Returns { selector } on success or { error } on failure. Never throws.
async function askDeepSeek({ target, structure }) {
  const cfg = await browser.storage.local.get({
    aiEnabled: false,
    deepseekApiKey: '',
    deepseekModel: 'deepseek-chat',
  });

  if (!cfg.aiEnabled) return { error: 'AI fallback is disabled in settings.' };
  if (!cfg.deepseekApiKey) return { error: 'No DeepSeek API key set in settings.' };

  const system =
    'You locate UI elements in a redacted HTML structure. Each element has a ' +
    'data-df="N" attribute. Reply ONLY with JSON: {"selector": "[data-df=\\"N\\"]"} ' +
    'choosing the single best element for the requested target. No prose.';
  const user =
    `Target to click: ${target}\n\n` +
    `Redacted structure (text removed; tags/roles/aria-labels only):\n${structure}`;

  try {
    const res = await fetch(DEEPSEEK_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${cfg.deepseekApiKey}`,
      },
      body: JSON.stringify({
        model: cfg.deepseekModel,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        temperature: 0,
        response_format: { type: 'json_object' },
        stream: false,
      }),
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      return { error: `DeepSeek HTTP ${res.status}: ${detail.slice(0, 200)}` };
    }
    const data = await res.json();
    const content = data && data.choices && data.choices[0] && data.choices[0].message
      ? data.choices[0].message.content
      : '';
    return { content };
  } catch (err) {
    return { error: 'DeepSeek request failed: ' + err.message };
  }
}

browser.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === 'ASK_AI') {
    // Returning a Promise makes this an async message responder in Firefox.
    return askDeepSeek(msg.payload || {});
  }
  return false;
});
