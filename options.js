// Options page logic: load/save DeepSeek AI-fallback settings to browser.storage.local.
'use strict';

const DEFAULTS = { aiEnabled: false, deepseekApiKey: '', deepseekModel: 'deepseek-chat' };

const enabledEl = document.getElementById('enabled');
const apiKeyEl = document.getElementById('apiKey');
const modelEl = document.getElementById('model');
const statusEl = document.getElementById('status');

async function load() {
  const cfg = await browser.storage.local.get(DEFAULTS);
  enabledEl.value = String(cfg.aiEnabled === true);
  apiKeyEl.value = cfg.deepseekApiKey || '';
  modelEl.value = cfg.deepseekModel || 'deepseek-chat';
}

async function save() {
  await browser.storage.local.set({
    aiEnabled: enabledEl.value === 'true',
    deepseekApiKey: apiKeyEl.value.trim(),
    deepseekModel: modelEl.value,
  });
  statusEl.textContent = 'Saved.';
  setTimeout(() => (statusEl.textContent = ''), 2000);
}

document.getElementById('save').addEventListener('click', save);
document.getElementById('toggleKey').addEventListener('click', () => {
  apiKeyEl.type = apiKeyEl.type === 'password' ? 'text' : 'password';
});

load();
