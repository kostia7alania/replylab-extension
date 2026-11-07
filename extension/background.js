import { generateTask } from './generation.js';
import { allowedSender } from './messaging.js';
import { createLibrary, PROFILE_FIELDS, normalizeStoredProfile, getConversationKey } from './library.js';
import { serverRequest, serverOrigin, permissionFor } from './server-client.js';

const library = createLibrary(chrome.storage.local);
const PAGE_ACTIONS = new Set(['library', 'capture', 'save-note', 'append-note', 'record-event', 'schedule', 'reschedule', 'cancel-schedule', 'complete-schedule', 'claim-schedule', 'translate', 'save-settings', 'open-conversation']);
const LOCAL_ACTIONS = new Set(['library', 'export', 'save-style', 'delete-style', 'duplicate-style', 'save-note', 'append-note', 'save-memory', 'delete-memory', 'save-settings', 'save-chat', 'fork-chat', 'delete-chat', 'capture', 'record-event', 'schedule', 'reschedule', 'cancel-schedule', 'complete-schedule', 'claim-schedule', 'import']);
const AI_ACTIONS = new Set(['replies', 'assistant', 'translate', 'summarize', 'create-style']);
const STREAMS = new Map();
const SYNC_ALARM = 'replylab:sync';
const ownPage = sender => { try { const url = new URL(sender.url); return sender.id === chrome.runtime.id && url.protocol === 'chrome-extension:' && url.hostname === chrome.runtime.id; } catch { return false; } };
const safeError = error => error?.message === 'Failed to fetch' ? 'Сервер недоступен. Проверьте адрес и запустите свой сервер.' : error?.message || 'Действие не выполнено.';
const failure = error => ({ ok: false, error: safeError(error), ...(['length', 'content-filter', 'auth', 'rate-limit', 'upstream', 'incomplete', 'invalid-output'].includes(error?.code) ? { code: error.code, retryable: error.retryable === true } : {}) });

async function checkSitePermission(sender) {
  if (!ownPage(sender) && new URL(sender.url).origin === 'https://web.whatsapp.com' && !await chrome.permissions.contains({ origins: ['https://web.whatsapp.com/*'] })) throw new Error('Разрешение на эту страницу отозвано. Подключите её заново в настройках.');
}

async function device() { return chrome.storage.local.get(['user', 'mode', 'model', 'serverToken', 'serverTokenOrigin', 'autoSendConsent', 'syncConsent', 'syncConsentOrigin', 'deviceId']); }
async function masked(state, local) {
  local ??= await device();
  return { ...state, settings: { ...state.settings, autoSendEnabled: state.settings.autoSendEnabled === true && local.autoSendConsent === true, syncEnabled: state.settings.syncEnabled === true && local.syncConsent === true && local.syncConsentOrigin === serverOrigin(state.settings.serverUrl) } };
}
async function connection(state, local) {
  local ??= await device();
  const origin = serverOrigin(state.settings.serverUrl);
  const canConnect = await chrome.permissions.contains({ origins: [permissionFor(origin)] });
  return { settings: state.settings, token: local.serverTokenOrigin === origin ? local.serverToken ?? '' : '', canConnect };
}
async function updateAlarm() {
  if (!chrome.alarms) return;
  const state = await masked(await library.getState());
  if (state.settings.syncEnabled) await chrome.alarms.create(SYNC_ALARM, { periodInMinutes: 1 });
  else await chrome.alarms.clear(SYNC_ALARM);
}
async function synchronize() {
  const local = await device(); const state = await library.getState();
  if (!(await masked(state, local)).settings.syncEnabled) throw new Error('Разрешите синхронизацию на этом устройстве в настройках.');
  const remote = await serverRequest('/sync', { ...await connection(state, local), method: 'POST', body: { state } });
  if (!remote?.state) throw new Error('Сервер не вернул библиотеку.');
  const merged = await library.dispatch('import', { data: remote.state, mode: 'merge' });
  return { state: await masked(merged), revision: remote.revision };
}
async function stableId(value) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(bytes)].map(value => value.toString(16).padStart(2, '0')).join('');
}
async function canonicalConversation(value) {
  if (!value || typeof value !== 'object' || !Array.isArray(value.messages ?? [])) throw new Error('Нужен контекст диалога.');
  const platform = String(value.platform ?? 'manual'); const chatId = String(value.chatId ?? value.id ?? '');
  const accountId = String(value.accountId ?? '');
  const accountScope = String(value.accountScope ?? '');
  if (platform === 'whatsapp' && !accountId && !accountScope.trim()) throw new Error('Перед сохранением задайте локальную метку аккаунта WhatsApp. Она отделяет ваши архивы и не подтверждает аккаунт.');
  if (!chatId) throw new Error('Нет идентификатора диалога.');
  const profile = value.profile ?? {};
  const photos = Array.isArray(value.photos) ? value.photos : Array.isArray(profile.photos) ? profile.photos : [];
  const counters = new Map();
  const messages = await Promise.all((value.messages ?? []).map(async message => {
    const text = String(message.text ?? message.content ?? '');
    const role = ['user', 'assistant', 'system', 'incoming', 'outgoing', 'unknown'].includes(message.role) ? message.role : 'unknown';
    const createdAt = typeof message.createdAt === 'string' && Number.isFinite(Date.parse(message.createdAt)) ? new Date(message.createdAt).toISOString() : null;
    const signature = JSON.stringify([platform, accountId, accountScope, chatId, role, text, createdAt]); const ordinal = counters.get(signature) ?? 0; counters.set(signature, ordinal + 1);
    return { id: typeof message.id === 'string' && message.id ? message.id : `derived:${await stableId(signature + ':' + ordinal)}`, role, text, createdAt, ...(Array.isArray(message.attachments) ? { attachments: message.attachments } : {}) };
  }));
  const normalizedProfile = raw => normalizeStoredProfile(Object.fromEntries(PROFILE_FIELDS.filter(key => raw?.[key] !== undefined).map(key => [key, raw[key]])));
  const state = await library.getState();
  const matches = state.conversations.filter(item => !item.deleted && item.platform === platform && item.accountId === accountId && (item.accountScope ?? '') === accountScope && item.chatId === chatId);
  const existing = matches.find(item => item.id === value.id) ?? (matches.length === 1 ? matches[0] : null);
  if (!existing && matches.length > 1) throw new Error('Для этого диалога найдено несколько записей. Выберите сохранённую запись перед обновлением.');
  return { id: existing?.id ?? getConversationKey({ platform, accountId, accountScope, chatId }), chatId, accountId, accountScope, platform, title: String(value.title ?? profile.name ?? 'Диалог'),
    profile: normalizedProfile({ ...profile, photos: Array.isArray(profile.photos) ? profile.photos : photos }),
    accountProfile: value.accountProfile == null ? null : normalizedProfile(value.accountProfile),
    messages, photos, partial: value.partial !== false, capturedAt: new Date().toISOString() };
}

async function targetConversation(payload, allowProvided = false) {
  const state = await library.getState();
  const local = payload.conversationId ? state.conversations.find(item => item.id === payload.conversationId && !item.deleted) : null;
  if (local && payload.conversation && getConversationKey(local) !== getConversationKey(payload.conversation)) throw new Error('Идентичность карточки не соответствует сохранённому диалогу.');
  const conversation = local ?? (allowProvided ? payload.conversation : null);
  if (!conversation || !['tinder', 'whatsapp'].includes(conversation.platform) || typeof conversation.chatId !== 'string' || !conversation.chatId) throw new Error('Выберите сохранённый диалог поддерживаемой платформы.');
  if (!conversation.accountId) throw new Error('Не удалось подтвердить аккаунт. Откройте нужный чат и используйте панель на странице.');
  getConversationKey(conversation);
  return conversation;
}

async function findConversationTabs(conversation, exactChat) {
  if (conversation.platform === 'whatsapp' && !await chrome.permissions.contains({ origins: ['https://web.whatsapp.com/*'] })) throw new Error('Разрешите WhatsApp Web в настройках.');
  // URL filters require broader tab access. Only our installed site adapters can answer this RPC.
  const tabs = (await chrome.tabs.query({})).sort((left, right) => Number(right.active) - Number(left.active));
  if (tabs.length > 500) throw new Error('Открыто больше 500 вкладок. Закройте лишние вкладки перед выбором чата.');
  const matches = [];
  for (const tab of tabs) {
    try {
      const identity = await chrome.tabs.sendMessage(tab.id, { type: 'replylab:identify' }, { frameId: 0 });
      if (identity?.ok && identity.platform === conversation.platform && identity.accountId === conversation.accountId && (!exactChat || identity.chatId === conversation.chatId)) matches.push({ tab, identity });
    } catch { /* A tab without an active adapter cannot prove its account. */ }
  }
  return matches;
}
async function ai(task, payload, { signal, onDelta } = {}) {
  const state = await library.getState(); const local = await device();
  let input = { ...payload };
  // prepareTask owns assistant history normalization, including the current user message.
  if (task === 'translate') input.language = payload.targetLanguage ?? payload.language ?? state.settings.language;
  const options = { ...local, ...await connection(state, local), settings: state.settings, library: state, model: payload.model || local.model || state.settings[task === 'replies' ? 'suggestionModel' : 'assistantModel'], signal, onDelta };
  return { ok: true, ...await generateTask(task, input, options) };
}
async function runAction(action, payload = {}, sender) {
  const privileged = ownPage(sender);
  if (!privileged && !PAGE_ACTIONS.has(action)) throw new Error('Это действие доступно только в настройках расширения.');
  if (action === 'insert-draft' || action === 'open-conversation') {
    const conversation = await targetConversation(payload, action === 'open-conversation');
    const matches = await findConversationTabs(conversation, action === 'insert-draft');
    const chosen = matches.find(item => item.tab.active && item.identity.visible) ?? (matches.length === 1 ? matches[0] : null);
    if (!chosen) throw new Error('Откройте один чат нужного аккаунта в браузере и повторите действие.');
    if (action === 'insert-draft') {
      if (typeof payload.text !== 'string' || !payload.text.trim() || payload.text.length > 10000) throw new Error('Текст черновика должен содержать от 1 до 10 000 символов.');
      await chrome.tabs.update(chosen.tab.id, { active: true });
      if (chrome.windows?.update && Number.isInteger(chosen.tab.windowId)) await chrome.windows.update(chosen.tab.windowId, { focused: true });
      let ready = false;
      for (let attempt = 0; attempt < 20; attempt++) {
        const identity = await chrome.tabs.sendMessage(chosen.tab.id, { type: 'replylab:identify' }, { frameId: 0 });
        if (!identity?.ok || identity.platform !== conversation.platform || identity.accountId !== conversation.accountId || identity.chatId !== conversation.chatId) throw new Error('Открытый диалог изменился. Черновик не вставлен.');
        if (identity.visible) { ready = true; break; }
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      if (!ready) throw new Error('Сделайте вкладку чата видимой и повторите вставку.');
      const result = await chrome.tabs.sendMessage(chosen.tab.id, { type: 'replylab:insert-draft', expected: { platform: conversation.platform, accountId: conversation.accountId, chatId: conversation.chatId }, text: payload.text }, { frameId: 0 });
      if (!result?.ok) throw new Error(result?.error || 'Страница не подтвердила подготовку черновика.');
      return { ok: true, pendingConfirmation: result.pendingConfirmation === true };
    }
    if (conversation.platform !== 'tinder') throw new Error('Выберите нужный диалог WhatsApp вручную. Автоматический переход не подтверждён.');
    await chrome.tabs.update(chosen.tab.id, { active: true, url: 'https://tinder.com/app/messages/' + encodeURIComponent(conversation.chatId) });
    return { ok: true };
  }
  if (action === 'whatsapp-enable') {
    if (!(await chrome.permissions.contains({ origins: ['https://web.whatsapp.com/*'] }))) throw new Error('Сначала разрешите доступ к WhatsApp Web.');
    await optionalScripts(); return { ok: true };
  }
  if (action === 'server-credentials') {
    if (typeof payload.token !== 'string' || payload.token.length > 8000) throw new Error('Некорректный токен сервера.');
    const state = await library.getState();
    await chrome.storage.local.set({ serverToken: payload.token.trim(), serverTokenOrigin: serverOrigin(state.settings.serverUrl) }); return { ok: true };
  }
  if (AI_ACTIONS.has(action)) return ai(action, payload);
  if (action === 'sync') return { ok: true, ...await synchronize() };
  if (LOCAL_ACTIONS.has(action)) {
    if (['save-note', 'append-note'].includes(action) && payload.conversation) payload = { ...payload, ...payload.conversation };
    if (action === 'capture') payload = { conversation: await canonicalConversation(payload.conversation ?? payload.context ?? payload) };
    if (action === 'save-settings' && !privileged) {
      if (!payload.settings || Object.keys(payload.settings).some(key => !['blurImages', 'geo'].includes(key))) throw new Error('Страница может менять только видимость изображений и геолокацию.');
    }
    if (action === 'claim-schedule') {
      const state = await library.getState(); const local = await device();
      if (!(await masked(state, local)).settings.autoSendEnabled) throw new Error('Автоотправка не разрешена на этом устройстве.');
      const item = state.schedules.find(item => item.id === payload.id && !item.deleted);
      if (!payload.accountId || !item || item.status !== 'scheduled' || item.sendMode !== 'automatic' || item.accountId !== payload.accountId || item.chatId !== payload.chatId || item.incomingSnapshot !== payload.incomingSnapshot || Date.parse(item.fireAt) > Date.now()) throw new Error('Запись расписания нельзя выполнить.');
      const unchanged = current => current && current.status === 'scheduled' && current.fireAt === payload.expected?.fireAt
        && current.text === payload.expected?.text && current.updatedAt === payload.expected?.updatedAt && current.incomingSnapshot === payload.incomingSnapshot;
      if (!unchanged(item)) throw new Error('Версия записи расписания изменилась.');
      if ((await masked(state, local)).settings.syncEnabled) {
        if (!local.deviceId) { local.deviceId = crypto.randomUUID(); await chrome.storage.local.set({ deviceId: local.deviceId }); }
        await synchronize();
        if (!unchanged((await library.getState()).schedules.find(record => record.id === item.id && !record.deleted))) throw new Error('Запись расписания изменилась при синхронизации.');
        await serverRequest('/schedules/claim', { ...await connection(state, local), method: 'POST', body: { id: item.id, fireAt: item.fireAt, deviceId: local.deviceId, incomingSnapshot: payload.incomingSnapshot, expectedText: item.text, expectedUpdatedAt: item.updatedAt } });
      }
    }
    const result = await library.dispatch(action, payload);
    if (action === 'save-settings' && privileged) {
      const consent = {};
      if (Object.hasOwn(payload.settings, 'autoSendEnabled')) consent.autoSendConsent = payload.settings.autoSendEnabled === true;
      if (Object.hasOwn(payload.settings, 'syncEnabled')) {
        consent.syncConsent = payload.settings.syncEnabled === true;
        consent.syncConsentOrigin = payload.settings.syncEnabled === true ? serverOrigin(result.settings.serverUrl) : '';
      }
      if (Object.keys(consent).length) await chrome.storage.local.set(consent);
      await updateAlarm();
    }
    if (action === 'import') await updateAlarm();
    return action === 'export' ? { ok: true, result } : { ok: true, state: await masked(result) };
  }
  const state = await library.getState(); const local = await device(); const options = await connection(state, local);
  const catalog = /^(catalog|template)-(list|save|delete)$/.exec(action);
  if (catalog) {
    const path = catalog[1] === 'catalog' ? '/catalog' : '/templates';
    if (catalog[2] === 'list') return { ok: true, ...await serverRequest(path, options) };
    if (catalog[2] === 'delete') {
      if (typeof payload.id !== 'string' || !payload.id) throw new Error('Нужен ID записи каталога.');
      return { ok: true, ...await serverRequest(path + '/' + encodeURIComponent(payload.id), { ...options, method: 'DELETE' }) };
    }
    return { ok: true, ...await serverRequest(path + (payload.id ? '/' + encodeURIComponent(payload.id) : ''), { ...options, method: payload.id ? 'PUT' : 'POST', body: catalog[1] === 'catalog' ? { style: payload.style } : { template: payload.template } }) };
  }
  if (action === 'server-status') return { ok: true, ...await serverRequest('/status', options) };
  if (action === 'provider-models') return { ok: true, ...await serverRequest('/models?provider=' + encodeURIComponent(payload.provider ?? state.settings.provider), options) };
  if (action === 'provider-usage') return { ok: true, ...await serverRequest('/provider-usage?provider=' + encodeURIComponent(payload.provider ?? state.settings.provider), options) };
  if (action === 'provider-credentials') return { ok: true, ...await serverRequest('/credentials', { ...options, method: 'POST', body: payload }) };
  if (action === 'search') return { ok: true, ...await serverRequest('/search?q=' + encodeURIComponent(payload.query ?? ''), options) };
  if (action === 'analytics') return { ok: true, ...await serverRequest('/analytics?tz=' + encodeURIComponent(payload.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone), options) };
  if (action === 'share') {
    const conversation = await canonicalConversation(payload.conversation);
    const shared = await serverRequest('/shares', { ...options, method: 'POST', body: { conversation, ttlHours: payload.ttlSeconds === undefined ? 24 : Number(payload.ttlSeconds) / 3600 } });
    return { ok: true, ...shared, id: shared.token };
  }
  if (action === 'revoke-share') return { ok: true, ...await serverRequest('/shares/' + encodeURIComponent(payload.id), { ...options, method: 'DELETE' }) };
  if (action === 'oauth-status') return { ok: true, ...await serverRequest('/oauth/status', options) };
  if (['oauth-start', 'oauth-select', 'oauth-disconnect'].includes(action)) return { ok: true, ...await serverRequest('/oauth/' + action.slice(6), { ...options, method: 'POST', body: payload }) };
  throw new Error('Неизвестное действие ReplyLab.');
}

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (!['replylab:suggest', 'replylab:action', 'replylab:open-options'].includes(message?.type)) return false;
  if (!allowedSender(sender, chrome.runtime.id)) { respond({ ok: false, error: 'Источник запроса не разрешён.' }); return false; }
  (async () => {
    await checkSitePermission(sender);
    if (message.type === 'replylab:suggest') return ai('replies', message);
    if (message.type === 'replylab:action') return runAction(message.action, message.payload ?? {}, sender);
    if (message.context) {
      const conversation = await canonicalConversation(message.context);
      await library.dispatch('capture', { conversation }); await chrome.storage.local.set({ activeConversation: conversation.id });
    }
    const view = ['assistant', 'styles', 'history', 'analytics', 'schedules', 'settings'].includes(message.view) ? message.view : '';
    await chrome.tabs.create({ url: chrome.runtime.getURL('index.html') + (view ? '#' + view : '') });
    return { ok: true };
  })().then(respond, error => respond(failure(error))); return true;
});

chrome.runtime.onConnect?.addListener(port => {
  if (port.name !== 'replylab:stream' || !allowedSender(port.sender, chrome.runtime.id)) { port.disconnect(); return; }
  const own = ownPage(port.sender); const requests = new Map();
  const post = value => { try { port.postMessage(value); } catch {} };
  port.onMessage.addListener(message => {
    if (message?.type === 'cancel') { requests.get(message.id)?.abort(); return; }
    if (typeof message?.id !== 'string' || !AI_ACTIONS.has(message.task) || (!own && message.task !== 'replies') || requests.has(message.id)) { post({ type: 'error', id: message?.id, error: 'Запрос потока не разрешён.' }); return; }
    if (STREAMS.size >= 4) { post({ type: 'error', id: message.id, error: 'Одновременно доступны четыре потока.' }); return; }
    const controller = new AbortController(); const key = Symbol(message.id); requests.set(message.id, controller); STREAMS.set(key, controller);
    checkSitePermission(port.sender).then(() => ai(message.task, message.payload ?? {}, { signal: controller.signal, onDelta: text => post({ type: 'delta', id: message.id, text }) }))
      .then(result => post({ type: 'result', id: message.id, result }), error => post({ type: 'error', id: message.id, ...failure(error) }))
      .finally(() => { requests.delete(message.id); STREAMS.delete(key); });
  });
  port.onDisconnect.addListener(() => { for (const controller of requests.values()) controller.abort(); });
});

async function optionalScripts() {
  if (!chrome.scripting?.getRegisteredContentScripts) return;
  const ids = ['replylab-wa-main', 'replylab-wa-ui'];
  const existing = await chrome.scripting.getRegisteredContentScripts({ ids });
  if (existing.length) await chrome.scripting.unregisterContentScripts({ ids: existing.map(item => item.id) });
  if (await chrome.permissions.contains({ origins: ['https://web.whatsapp.com/*'] })) await chrome.scripting.registerContentScripts([
    { id: ids[0], matches: ['https://web.whatsapp.com/*'], js: ['site-bridge.js'], world: 'MAIN', runAt: 'document_start', persistAcrossSessions: true },
    { id: ids[1], matches: ['https://web.whatsapp.com/*'], js: ['content-loader.js'], world: 'ISOLATED', runAt: 'document_idle', persistAcrossSessions: true },
  ]);
}
const refresh = () => Promise.all([optionalScripts(), updateAlarm()]).catch(error => console.warn('ReplyLab: ' + safeError(error)));
chrome.permissions.onAdded?.addListener(refresh); chrome.permissions.onRemoved?.addListener(refresh);
chrome.runtime.onInstalled?.addListener(refresh); chrome.runtime.onStartup?.addListener(refresh);
chrome.alarms?.onAlarm.addListener(alarm => { if (alarm.name === SYNC_ALARM) synchronize().catch(error => console.warn('ReplyLab: ' + safeError(error))); });
refresh();
