import { activate, fixture, canUseApp } from './core.js';
import { rpc, stream } from './client.js';
import { permissionFor, serverOrigin } from './server-client.js';

const $ = (id) => document.getElementById(id);
const storage = chrome.storage.local;
let { user = null, model = '', mode = 'mock' } = await storage.get(['user', 'model', 'mode']);
const sample = 'Вы: Как прошёл твой день?\nСобеседник: Насыщенно! Теперь хочется куда-нибудь выбраться и переключиться.';
$('model').value = model;
$('mode').value = mode === 'gpt' ? 'gpt' : 'mock';
$('gpt-settings').hidden = mode !== 'gpt';
$('result-source').textContent = mode === 'gpt' ? 'Ваш GPT через локальный коннектор' : 'Локальные примеры';

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
$('mode').addEventListener('change', async () => {
  await storage.set({ mode: $('mode').value });
  $('gpt-settings').hidden = $('mode').value !== 'gpt';
  $('result-source').textContent = $('mode').value === 'gpt' ? 'Ваш GPT через локальный коннектор' : 'Локальные примеры';
});
$('connect').addEventListener('click', async () => {
  const granted = await chrome.permissions.request({ origins: ['http://127.0.0.1/*'] });
  notify(granted ? 'Доступ к локальному коннектору разрешён.' : 'Локальный коннектор не разрешён.', !granted);
});
$('model').addEventListener('change', () => storage.set({ model: $('model').value.trim() }));
$('generate').addEventListener('click', async () => {
  if (!canUseApp(user)) { notify('Включите локальный доступ кодом REPLYLAB-LOCAL.', true); return; }
  const text = $('conversation').value.trim();
  if (!text) { notify('Добавьте диалог или нажмите «Пример».', true); return; }
  $('generate').disabled = true; notify('Готовим варианты…');
  try {
    await storage.set({ mode: $('mode').value, model: $('model').value.trim() });
    if ($('model').value.trim()) await checked('save-settings', { settings: { suggestionModel: $('model').value.trim() } });
    const result = await chrome.runtime.sendMessage({ type: 'replylab:suggest', text, tone: $('tone').value });
    if (!result?.ok) throw new Error(result?.error || 'Не удалось получить ответы.');
    renderReplies(result.replies); notify($('mode').value === 'mock' ? `Локальных примеров: ${result.replies.length}. Данные остались на устройстве.` : 'Ответы получены через ваш коннектор.');
  } catch (error) { notify(error.message === 'Failed to fetch' ? 'Коннектор недоступен. Запустите npm start по инструкции.' : error.message, true); }
  finally { $('generate').disabled = false; }
});
refreshAccess();

let studio;
function showFailure(error) { notify(error.message || 'Действие не выполнено.', true); }
async function checked(action, payload) {
  const result = await rpc(action, payload);
  if (!result?.ok) throw new Error(result?.error || 'Действие не выполнено.');
  return result;
}
$('authorize-server').addEventListener('click', async () => {
  try {
    const origin = serverOrigin($('server-url').value);
    const granted = await chrome.permissions.request({ origins: [permissionFor(origin)] });
    if (!granted) throw new Error('Доступ к вашему серверу не разрешён.');
    await checked('save-settings', { settings: { serverUrl: origin } });
    notify('Ваш сервер разрешён.'); await studio?.refresh();
  } catch (error) { showFailure(error); }
});
$('enable-whatsapp').addEventListener('click', async () => {
  try {
    const granted = await chrome.permissions.request({ origins: ['https://web.whatsapp.com/*'] });
    if (!granted) throw new Error('Доступ к WhatsApp Web не разрешён.');
    await checked('whatsapp-enable'); notify('WhatsApp подключён. Обновите открытую вкладку WhatsApp Web.');
  } catch (error) { showFailure(error); }
});
$('save-provider-key').addEventListener('click', async () => {
  try {
    await checked('provider-credentials', { provider: $('key-provider').value, apiKey: $('provider-key').value, baseUrl: $('provider-base').value || undefined });
    $('provider-key').value = ''; notify('Ключ сохранён только на вашем сервере.');
  } catch (error) { showFailure(error); }
});
try {
  const state = await checked('library');
  $('server-url').value = state.state.settings.serverUrl;
  const { mountWorkspace } = await import('./workspace.js');
  studio = await mountWorkspace($('workspace'), { rpc, stream });
  const { activeConversation } = await storage.get('activeConversation');
  if (location.hash) await studio.open(decodeURIComponent(location.hash.slice(1)), activeConversation);
  window.addEventListener('hashchange', () => studio.open(decodeURIComponent(location.hash.slice(1)), activeConversation));
} catch (error) { showFailure(error); }
