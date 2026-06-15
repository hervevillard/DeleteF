// DeleteF background service worker.
//   1. On toolbar-button click → tell the content script to toggle the panel.
//   2. Handle AGENT_TURN messages → run one turn of the DeepSeek tool-calling
//      agent: forward the running message history + tool schemas to DeepSeek
//      (OpenAI-compatible) and return the raw assistant message (which may
//      contain tool_calls). The fetch lives here (not the content script)
//      because Facebook's page CSP blocks cross-origin requests from content
//      scripts. This is a DUMB PROXY — it owns no tool logic; content.js owns
//      the tool schemas, executes them against the DOM, and drives the loop.
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

// Run one agent turn. `messages` is the full OpenAI-format history (system,
// user, assistant-with-tool_calls, tool results); `tools` is the function
// schema list. Returns { message } (the assistant reply) or { error }.
// Never throws.
async function askDeepSeekAgent({ messages, tools }) {
  const cfg = await browser.storage.local.get({
    aiEnabled: false,
    deepseekApiKey: '',
    deepseekModel: 'deepseek-chat',
  });

  if (!cfg.aiEnabled) return { error: 'AI is disabled in settings.' };
  if (!cfg.deepseekApiKey) return { error: 'No DeepSeek API key set in settings.' };
  if (!Array.isArray(messages) || !messages.length) return { error: 'No messages to send.' };

  try {
    const res = await fetch(DEEPSEEK_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${cfg.deepseekApiKey}`,
      },
      body: JSON.stringify({
        model: cfg.deepseekModel,
        messages,
        tools,
        tool_choice: 'auto',
        temperature: 0,
        stream: false,
      }),
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      return { error: `DeepSeek HTTP ${res.status}: ${detail.slice(0, 300)}` };
    }
    const data = await res.json();
    const message =
      data && data.choices && data.choices[0] && data.choices[0].message
        ? data.choices[0].message
        : null;
    if (!message) return { error: 'DeepSeek returned no message.' };
    return { message };
  } catch (err) {
    return { error: 'DeepSeek request failed: ' + err.message };
  }
}

browser.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === 'AGENT_TURN') {
    // Returning a Promise makes this an async message responder in Firefox.
    return askDeepSeekAgent(msg.payload || {});
  }
  return false;
});
