import { generateReplies } from './generation.js';
import { allowedSender } from './messaging.js';

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (!['replylab:suggest', 'replylab:open-options'].includes(message?.type)) return false;
  if (!allowedSender(sender, chrome.runtime.id)) { respond({ ok: false, error: 'Источник запроса не разрешён.' }); return false; }
  (async () => {
    if (message.type === 'replylab:open-options') {
      await chrome.runtime.openOptionsPage(); return { ok: true };
    }
    const state = await chrome.storage.local.get(['user', 'mode', 'model']);
    const canConnect = state.mode === 'gpt' && await chrome.permissions.contains({ origins: ['http://127.0.0.1/*'] });
    const replies = await generateReplies(message, { ...state, canConnect });
    return { ok: true, replies };
  })().then(respond, (error) => respond({ ok: false, error: error.message === 'Failed to fetch' ? 'Локальный коннектор недоступен. Запустите npm start.' : error.message }));
  return true;
});
