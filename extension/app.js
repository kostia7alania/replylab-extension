import { activate, fixture, canUseApp, suggestReplies } from './core.js';

const $ = (id) => document.getElementById(id);
const storage = chrome.storage.local;
let { user = null, model = '' } = await storage.get(['user', 'model']);
const sample = 'Вы: Как прошёл твой день?\nСобеседник: Насыщенно! Теперь хочется куда-нибудь выбраться и переключиться.';
$('model').value = model;

function notify(text, error = false) {
  $('message').textContent = text;
  $('message').classList.toggle('error', error);
}
function refreshAccess() {
  const allowed = canUseApp(user);
  $('access-label').textContent = allowed ? (user.isOnTrial ? 'Пробный сценарий включён' : 'Локальный доступ открыт') : 'Локальный доступ закрыт';
  document.querySelector('.status-dot').classList.toggle('active', allowed);
  $('access-title').textContent = allowed ? 'Можно пробовать!' : 'Сначала попробуем?';
}
async function setUser(value) {
  user = value;
  await storage.set({ user });
  $('suggestions').replaceChildren();
  refreshAccess();
}
function renderReplies(replies) {
  const elements = replies.map(({ text, reason }) => {
    const article = document.createElement('article');
    article.className = 'reply';
    const content = document.createElement('p'); content.textContent = text;
    const meta = document.createElement('div'); meta.className = 'reply-meta';
    const why = document.createElement('small'); why.textContent = reason;
    const copy = document.createElement('button'); copy.className = 'copy'; copy.textContent = 'Копировать';
    copy.addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(text); copy.textContent = 'Скопировано'; }
      catch { notify('Не удалось скопировать. Выделите текст ответа вручную.', true); }
    });
    meta.append(why, copy); article.append(content, meta); return article;
  });
  $('suggestions').replaceChildren(...elements);
}
$('activate-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  try { await setUser(activate($('code').value)); notify('Тестовый доступ включён. Нажмите «Пример» и предложите ответы.'); }
  catch (error) { notify(error.message, true); }
});
document.querySelectorAll('[data-scenario]').forEach((button) => button.addEventListener('click', async () => {
  try { await setUser(fixture(button.dataset.scenario)); notify('Локальный сценарий изменён.'); }
  catch (error) { notify(error.message, true); }
}));
$('sample').addEventListener('click', () => { $('conversation').value = sample; notify('Пример диалога готов.'); });
$('selection').addEventListener('click', async () => {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const [{ result }] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: () => window.getSelection()?.toString() ?? '' });
    if (!result.trim()) throw new Error('Сначала выделите текст на странице.');
    $('conversation').value = result.slice(0, 10000); notify('Выделенный текст добавлен.');
  } catch { notify('Выделите текст на обычной странице и откройте ReplyLab с панели расширений.', true); }
});
$('expand').addEventListener('click', () => chrome.runtime.openOptionsPage());
$('mode').addEventListener('change', () => {
  $('gpt-settings').hidden = $('mode').value !== 'gpt';
  $('result-source').textContent = $('mode').value === 'gpt' ? 'Ваш GPT через локальный коннектор' : 'Локальные примеры';
});
$('connect').addEventListener('click', async () => {
  const granted = await chrome.permissions.request({ origins: ['http://127.0.0.1/*'] });
  notify(granted ? 'Доступ к локальному коннектору разрешён.' : 'Локальный коннектор не разрешён.', !granted);
});
$('generate').addEventListener('click', async () => {
  if (!canUseApp(user)) { notify('Включите локальный доступ кодом REPLYLAB-LOCAL.', true); return; }
  const text = $('conversation').value.trim();
  if (!text) { notify('Добавьте диалог или нажмите «Пример».', true); return; }
  $('generate').disabled = true; notify('Готовим варианты…');
  try {
    let replies;
    if ($('mode').value === 'mock') replies = suggestReplies(text, $('tone').value);
    else {
      const permitted = await chrome.permissions.contains({ origins: ['http://127.0.0.1/*'] });
      if (!permitted) throw new Error('Нажмите «Разрешить локальный коннектор».');
      model = $('model').value.trim();
      if (!model) throw new Error('Укажите точный ID модели вашего API.');
      await storage.set({ model });
      const response = await fetch('http://127.0.0.1:4318/replies', { method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-ReplyLab': '1' },
        body: JSON.stringify({ text, tone: $('tone').value, model }), signal: AbortSignal.timeout(45000) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || `Ошибка коннектора: ${response.status}`);
      if (!Array.isArray(data.replies) || data.replies.length !== 3 || data.replies.some((r) => typeof r.text !== 'string' || typeof r.reason !== 'string')) throw new Error('Коннектор вернул неверный формат.');
      replies = data.replies;
    }
    renderReplies(replies); notify($('mode').value === 'mock' ? 'Три локальных примера. Данные остались на устройстве.' : 'Ответы получены через ваш коннектор.');
  } catch (error) { notify(error.message === 'Failed to fetch' ? 'Коннектор недоступен. Запустите npm start по инструкции.' : error.message, true); }
  finally { $('generate').disabled = false; }
});
refreshAccess();
