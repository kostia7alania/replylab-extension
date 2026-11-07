export const LIMITS = Object.freeze({ assistantChats: 20, messages: 40, attachments: 4, attachmentBytes: 1000000, stateBytes: 8000000 });
export const DEFAULT_SETTINGS = Object.freeze({
  provider: 'openai', suggestionModel: '', assistantModel: '', systemPrompt: '', suggestionCount: 3,
  showSharedPrompts: true, blurImages: false, autoSendEnabled: false, language: 'ru',
  sendOnEnter: false, showProfile: true, showTools: true, showNotes: true, showTranslation: true, showSchedule: true,
  suggestionProvider: '', assistantProvider: '', devMode: false, onboardingCompleted: false,
  geo: { enabled: false, latitude: 0, longitude: 0, accuracy: 100 },
  syncEnabled: false, serverUrl: 'http://127.0.0.1:4318',
});
const COLLECTIONS = ['styles', 'memories', 'assistantChats', 'conversations', 'events', 'schedules'];
const CONDITIONS = ['opener', 'incoming', 'stale', 'empty'];
const BAD_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const copy = value => structuredClone(value);
const nowISO = () => new Date().toISOString();
const id = () => crypto.randomUUID();
const active = list => list.filter(item => !item.deleted);
function plain(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value)));
}
function keys(value, allowed, label) {
  if (!plain(value)) throw new TypeError(label + ': ожидается объект.');
  for (const key of Object.keys(value)) if (BAD_KEYS.has(key) || !allowed.includes(key)) throw new TypeError(label + ': неизвестное поле ' + key);
}
function text(value, limit, label, fallback = '') {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || value.length > limit) throw new TypeError(label + ': некорректный текст или превышен лимит.');
  return value;
}
function bool(value, fallback = false) {
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') throw new TypeError('Ожидается логическое значение.');
  return value;
}
function number(value, min, max, fallback) {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value < min || value > max) throw new RangeError('Число вне диапазона ' + min + '–' + max);
  return value;
}
function choice(value, choices, fallback) {
  if (value === undefined) return fallback;
  if (!choices.includes(value)) throw new TypeError('Неизвестное значение: ' + String(value));
  return value;
}
function date(value, fallback = nowISO()) {
  const parsed = text(value, 40, 'Дата', fallback);
  if (!Number.isFinite(Date.parse(parsed))) throw new TypeError('Некорректная дата.');
  return new Date(parsed).toISOString();
}
function recordID(value, fallback = id()) {
  const result = text(value, 200, 'ID', fallback);
  if (!result || BAD_KEYS.has(result)) throw new TypeError('Некорректный ID.');
  return result;
}
function list(value, max, label) {
  if (!Array.isArray(value) || value.length > max) throw new RangeError(label + ': превышен лимит ' + max + '. Сначала экспортируйте данные и удалите ненужные записи.');
  return value;
}
function base(record) {
  return { id: recordID(record.id), createdAt: date(record.createdAt), updatedAt: date(record.updatedAt), ...(record.deleted ? { deleted: true } : {}) };
}
function attachment(value) {
  keys(value, ['name', 'mimeType', 'text', 'dataUrl'], 'Вложение');
  const result = { name: text(value.name, 200, 'Имя файла'), mimeType: text(value.mimeType, 100, 'MIME') };
  if (value.text !== undefined) result.text = text(value.text, 100000, 'Текст файла');
  if (value.dataUrl !== undefined) {
    result.dataUrl = text(value.dataUrl, Math.ceil(LIMITS.attachmentBytes * 1.4), 'Изображение');
    if (!/^data:image\/(?:png|jpeg|webp|gif);base64,[A-Za-z0-9+/=\r\n]+$/.test(result.dataUrl)) throw new TypeError('Поддерживаются только PNG, JPEG, WebP и GIF.');
  }
  if (!result.text && !result.dataUrl) throw new TypeError('Пустое вложение.');
  return result;
}
function message(value) {
  keys(value, ['id', 'role', 'text', 'createdAt', 'attachments'], 'Сообщение');
  return { id: recordID(value.id), role: choice(value.role, ['user', 'assistant', 'system', 'incoming', 'outgoing', 'unknown'], 'unknown'),
    text: text(value.text, 50000, 'Сообщение'), createdAt: value.createdAt == null ? null : date(value.createdAt),
    attachments: list(value.attachments ?? [], LIMITS.attachments, 'Вложения').map(attachment) };
}
function style(value) {
  keys(value, ['id', 'name', 'prompt', 'model', 'temperature', 'maxTokens', 'conditions', 'suggestionCount', 'shared', 'useHistory', 'createdAt', 'updatedAt', 'deleted'], 'Стиль');
  const common = base(value); if (common.deleted) return common;
  if (value.suggestionCount !== undefined && !Number.isInteger(value.suggestionCount)) throw new TypeError('Количество ответов должно быть целым.');
  if (value.maxTokens !== undefined && !Number.isInteger(value.maxTokens)) throw new TypeError('Лимит токенов должен быть целым.');
  return { ...common, name: text(value.name, 120, 'Название', 'Новый стиль'), prompt: text(value.prompt, 20000, 'Промпт'),
    model: text(value.model, 150, 'Модель'), temperature: number(value.temperature, 0, 2, 0.7),
    maxTokens: number(value.maxTokens, 16, 16000, 1000), suggestionCount: number(value.suggestionCount, 1, 3, 3),
    conditions: [...new Set(list(value.conditions ?? CONDITIONS, 4, 'Условия').map(item => choice(item, CONDITIONS)))],
    shared: bool(value.shared), useHistory: bool(value.useHistory) };
}
function memory(value) {
  keys(value, ['id', 'text', 'enabled', 'createdAt', 'updatedAt', 'deleted'], 'Память');
  const common = base(value); if (common.deleted) return common;
  const content = text(value.text, 10000, 'Память');
  if (!content.trim()) throw new TypeError('Запись памяти не может быть пустой.');
  return { ...common, text: content, enabled: bool(value.enabled, true) };
}
function assistantChat(value) {
  keys(value, ['id', 'title', 'model', 'messages', 'createdAt', 'updatedAt', 'deleted'], 'AI-диалог');
  const common = base(value); if (common.deleted) return common;
  return { ...common, title: text(value.title, 150, 'Название', 'Новый диалог'), model: text(value.model, 150, 'Модель'),
    messages: list(value.messages ?? [], LIMITS.messages, 'Сообщения AI-диалога').map(message) };
}
function photo(value) {
  const url = text(value, 4000, 'Адрес фотографии');
  if (!/^https?:\/\//.test(url)) throw new TypeError('Некорректный URL фотографии.');
  return url;
}
function conversation(value) {
  keys(value, ['id', 'chatId', 'accountId', 'platform', 'title', 'profile', 'messages', 'photos', 'partial', 'capturedAt', 'createdAt', 'updatedAt', 'deleted'], 'Диалог');
  const common = base({ ...value, id: value.id ?? value.chatId }); if (common.deleted) return common;
  const profile = value.profile ?? {};
  keys(profile, ['id', 'name', 'bio', 'photos'], 'Профиль');
  return { ...common, chatId: recordID(value.chatId, common.id), accountId: text(value.accountId, 200, 'ID аккаунта'),
    platform: text(value.platform, 40, 'Платформа', 'manual'),
    title: text(value.title, 200, 'Название', profile.name ?? 'Диалог'),
    profile: { id: text(profile.id, 200, 'ID профиля'), name: text(profile.name, 150, 'Имя'), bio: text(profile.bio, 10000, 'Описание'),
      photos: list(profile.photos ?? [], 20, 'Фото').map(photo) },
    messages: list(value.messages ?? [], 2000, 'Сообщения диалога').map(message),
    photos: list(value.photos ?? [], 20, 'Фото').map(photo), partial: bool(value.partial, true), capturedAt: date(value.capturedAt) };
}
function event(value) {
  keys(value, ['id', 'kind', 'type', 'platform', 'chatId', 'conversationId', 'at', 'createdAt', 'updatedAt', 'deleted', 'profile', 'count'], 'Событие');
  const at = date(value.at ?? value.createdAt);
  return { ...base({ ...value, createdAt: at }), kind: text(value.kind ?? value.type, 60, 'Событие', 'capture'),
    type: text(value.type ?? value.kind, 60, 'Событие', 'capture'), platform: text(value.platform, 40, 'Платформа', 'manual'),
    chatId: text(value.chatId ?? value.conversationId, 200, 'ID диалога'), conversationId: text(value.conversationId ?? value.chatId, 200, 'ID диалога'),
    at, count: number(value.count, 0, 100000, 1),
    ...(value.profile ? { profile: eventProfile(value.profile) } : {}) };
}
function eventProfile(value) {
  keys(value, ['id', 'name', 'bio', 'photos', 'age', 'city', 'distanceKm', 'birthDate', 'idTimestamp'], 'Профиль события');
  const core = conversation({ chatId: 'event-profile', profile: { id: value.id, name: value.name, bio: value.bio, photos: value.photos } }).profile;
  return { ...core, age: value.age == null ? null : number(value.age, 18, 120),
    city: text(value.city, 150, 'Город'), distanceKm: value.distanceKm == null ? null : number(value.distanceKm, 0, 50000),
    birthDate: value.birthDate == null ? null : date(value.birthDate), idTimestamp: value.idTimestamp == null ? null : date(value.idTimestamp) };
}
function schedule(value) {
  keys(value, ['id', 'chatId', 'platform', 'text', 'fireAt', 'requestedFor', 'variationSeconds', 'skipIfNewMessage', 'status', 'sendMode', 'incomingSnapshot', 'error', 'createdAt', 'updatedAt', 'deleted'], 'Расписание');
  const common = base(value); if (common.deleted) return common;
  const content = text(value.text, 10000, 'Ответ');
  if (!content.trim()) throw new TypeError('Запланированный ответ не может быть пустым.');
  const sendMode = choice(value.sendMode, ['review', 'automatic'], 'review');
  const skipIfNewMessage = bool(value.skipIfNewMessage, true);
  if (sendMode === 'automatic' && !skipIfNewMessage) throw new TypeError('Автоотправка требует отмены при новом сообщении.');
  const variationSeconds = number(value.variationSeconds, 0, 3600, 0);
  if (!Number.isInteger(variationSeconds)) throw new TypeError('Вариация времени должна быть целым числом секунд.');
  return { ...common, chatId: recordID(value.chatId), platform: text(value.platform, 40, 'Платформа', 'manual'),
    text: content, fireAt: date(value.fireAt), requestedFor: date(value.requestedFor ?? value.fireAt), variationSeconds, skipIfNewMessage,
    status: choice(value.status, ['scheduled', 'firing', 'ready', 'sent', 'failed', 'cancelled', 'completed'], 'scheduled'),
    sendMode, incomingSnapshot: text(value.incomingSnapshot, 50000, 'Снимок входящего'),
    error: text(value.error, 1000, 'Ошибка') };
}
export function validateSettings(value) {
  keys(value, [...Object.keys(DEFAULT_SETTINGS), 'updatedAt'], 'Настройки');
  const geo = value.geo ?? DEFAULT_SETTINGS.geo;
  keys(geo, ['enabled', 'latitude', 'longitude', 'accuracy'], 'Геолокация');
  const serverUrl = text(value.serverUrl, 1000, 'Адрес сервера', DEFAULT_SETTINGS.serverUrl);
  const url = new URL(serverUrl);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash || url.search) throw new TypeError('Некорректный адрес сервера.');
  const suggestionCount = number(value.suggestionCount, 1, 3, 3);
  if (!Number.isInteger(suggestionCount)) throw new TypeError('Количество ответов должно быть целым.');
  return { provider: choice(value.provider, ['openai', 'openrouter', 'compatible', 'chatgpt'], 'openai'),
    suggestionModel: text(value.suggestionModel, 150, 'Модель подсказок'), assistantModel: text(value.assistantModel, 150, 'Модель помощника'),
    systemPrompt: text(value.systemPrompt, 30000, 'Системный промпт'), suggestionCount,
    showSharedPrompts: bool(value.showSharedPrompts, true), blurImages: bool(value.blurImages), autoSendEnabled: bool(value.autoSendEnabled),
    sendOnEnter: bool(value.sendOnEnter), showProfile: bool(value.showProfile, true), showTools: bool(value.showTools, true),
    showNotes: bool(value.showNotes, true), showTranslation: bool(value.showTranslation, true), showSchedule: bool(value.showSchedule, true),
    suggestionProvider: choice(value.suggestionProvider, ['', 'openai', 'openrouter', 'compatible', 'chatgpt'], ''),
    assistantProvider: choice(value.assistantProvider, ['', 'openai', 'openrouter', 'compatible', 'chatgpt'], ''),
    devMode: bool(value.devMode), onboardingCompleted: bool(value.onboardingCompleted),
    language: choice(value.language, ['ru', 'en', 'de', 'fr', 'es', 'pt', 'da', 'sv', 'fi', 'lt', 'pl'], 'ru'),
    geo: { enabled: bool(geo.enabled), latitude: number(geo.latitude, -90, 90, 0), longitude: number(geo.longitude, -180, 180, 0), accuracy: number(geo.accuracy, 0, 100000, 100) },
    syncEnabled: bool(value.syncEnabled), serverUrl: url.origin, ...(value.updatedAt ? { updatedAt: date(value.updatedAt) } : {}) };
}
const NORMALIZE = { styles: style, memories: memory, assistantChats: assistantChat, conversations: conversation, events: event, schedules: schedule };
export function validateLibrary(value) {
  keys(value, ['version', ...COLLECTIONS, 'notes', 'settings'], 'Библиотека');
  if (value.version !== 1) throw new TypeError('Неподдерживаемая версия библиотеки.');
  const result = { version: 1 };
  for (const key of COLLECTIONS) {
    result[key] = list(value[key] ?? [], key === 'events' ? 20000 : 2000, key).map(NORMALIZE[key]);
    const ids = result[key].map(item => item.id);
    if (new Set(ids).size !== ids.length) throw new TypeError('Повторяющийся ID в ' + key);
  }
  if (active(result.assistantChats).length > LIMITS.assistantChats) throw new RangeError('Лимит 20 AI-диалогов. Сначала экспортируйте данные и удалите ненужный диалог.');
  const notes = value.notes ?? {};
  if (!plain(notes) || Object.keys(notes).length > 2000) throw new TypeError('Некорректные заметки.');
  result.notes = {};
  for (const [key, note] of Object.entries(notes)) {
    recordID(key); keys(note, ['text', 'updatedAt'], 'Заметка');
    result.notes[key] = { text: text(note.text, 30000, 'Заметка'), updatedAt: date(note.updatedAt) };
  }
  result.settings = validateSettings(value.settings ?? {});
  if (new TextEncoder().encode(JSON.stringify(result)).length > LIMITS.stateBytes) throw new RangeError('Библиотека больше 8 МБ. Экспортируйте и уменьшите объём вложений.');
  return result;
}
export function initialLibrary() {
  return validateLibrary({ version: 1, styles: [
    { id: 'local-friendly', name: 'Дружелюбный ответ', prompt: 'Ответь {{name}} тепло и естественно. Контекст: {{transcript}}. Заметки: {{notes}}. Память: {{memories}}', shared: true },
    { id: 'local-opener', name: 'Первое сообщение', prompt: 'Предложи короткое начало разговора с {{name}}. Описание: {{bio}}.', conditions: ['opener', 'empty'], shared: true },
  ] });
}
export function renderStyle(prompt, values = {}) {
  return text(prompt, 20000, 'Промпт').replace(/\{\{\s*(name|bio|transcript|notes|memories)\s*\}\}/g, (_, key) => String(values[key] ?? ''));
}
function mergeArray(left, right) {
  const merged = new Map(left.map(item => [item.id, item]));
  for (const item of right) {
    const old = merged.get(item.id);
    const newer = !old || Date.parse(item.updatedAt) > Date.parse(old.updatedAt);
    const tie = old && Date.parse(item.updatedAt) === Date.parse(old.updatedAt) && (item.deleted || !old.deleted);
    if (newer || tie) {
      if (old && !old.deleted && !item.deleted && Array.isArray(old.messages) && Array.isArray(item.messages)) {
        const messages = new Map(old.messages.map(message => [message.id, message]));
        for (const message of item.messages) messages.set(message.id, message);
        merged.set(item.id, { ...item, messages: [...messages.values()] });
      } else merged.set(item.id, item);
    } else if (old && !old.deleted && !item.deleted && Array.isArray(old.messages) && Array.isArray(item.messages)) {
      const messages = new Map(item.messages.map(message => [message.id, message]));
      for (const message of old.messages) messages.set(message.id, message);
      merged.set(item.id, { ...old, messages: [...messages.values()] });
    }
  }
  return [...merged.values()];
}
export function mergeLibraries(left, right) {
  left = validateLibrary(left); right = validateLibrary(right);
  const useRightSettings = right.settings.updatedAt && (!left.settings.updatedAt || Date.parse(right.settings.updatedAt) >= Date.parse(left.settings.updatedAt));
  const merged = { ...left, notes: { ...left.notes }, settings: useRightSettings ? right.settings : left.settings };
  for (const key of COLLECTIONS) merged[key] = mergeArray(left[key], right[key]);
  for (const [key, note] of Object.entries(right.notes)) if (!merged.notes[key] || Date.parse(note.updatedAt) >= Date.parse(merged.notes[key].updatedAt)) merged.notes[key] = note;
  return validateLibrary(merged);
}
export function createLibrary(storageAdapter) {
  let queue = Promise.resolve();
  const read = async () => {
    const stored = await storageAdapter.get('library');
    return stored.library === undefined ? initialLibrary() : validateLibrary(stored.library);
  };
  function serial(work) {
    const pending = queue.then(work);
    queue = pending.catch(() => {});
    return pending;
  }
  function dispatch(action, payload = {}) {
    return serial(async () => {
      if (action === 'export' && payload.raw === true) {
        const stored = await storageAdapter.get('library');
        return { format: 'replylab-library-recovery', exportedAt: nowISO(), state: copy(stored.library ?? null) };
      }
      const current = await read();
      if (action === 'library') return copy(current);
      if (action === 'export') return { format: 'replylab-library', exportedAt: nowISO(), state: copy(current) };
      let next = copy(current);
      const put = (key, item) => { const index = next[key].findIndex(old => old.id === item.id); if (index < 0) next[key].push(item); else next[key][index] = item; };
      const save = (key, value) => {
        if (!plain(value)) throw new TypeError('Ожидается запись.');
        const old = value.id ? next[key].find(item => item.id === value.id) : null;
        put(key, NORMALIZE[key]({ ...old, ...value, createdAt: old?.createdAt ?? value.createdAt ?? nowISO(), updatedAt: nowISO(), deleted: false }));
      };
      const remove = key => {
        const old = next[key].find(item => item.id === payload.id && !item.deleted);
        if (!old) throw new Error('Запись не найдена.');
        put(key, { id: old.id, createdAt: old.createdAt, updatedAt: nowISO(), deleted: true });
      };
      switch (action) {
        case 'save-style': save('styles', payload.style); break;
        case 'delete-style': remove('styles'); break;
        case 'duplicate-style': {
          const old = next.styles.find(item => item.id === payload.id && !item.deleted);
          if (!old) throw new Error('Стиль не найден.');
          save('styles', { ...old, id: id(), name: old.name.slice(0, 105) + ' (копия)', shared: false }); break;
        }
        case 'save-note': {
          const key = recordID(payload.chatId);
          next.notes[key] = { text: text(payload.text, 30000, 'Заметка'), updatedAt: nowISO() }; break;
        }
        case 'save-memory': save('memories', payload.memory); break;
        case 'delete-memory': remove('memories'); break;
        case 'save-settings': next.settings = validateSettings({ ...next.settings, ...payload.settings, updatedAt: nowISO() }); break;
        case 'save-chat': {
          const incoming = payload.chat;
          const old = next.assistantChats.find(item => item.id === incoming?.id);
          const messages = new Map((old?.messages ?? []).map(item => [item.id, item]));
          for (const item of incoming?.messages ?? []) {
            const normalized = message(item);
            messages.set(normalized.id, normalized);
          }
          save('assistantChats', { ...incoming, messages: [...messages.values()] }); break;
        }
        case 'delete-chat': remove('assistantChats'); break;
        case 'capture': {
          const incoming = payload.conversation;
          const old = next.conversations.find(item => item.id === (incoming?.id ?? incoming?.chatId));
          const messages = new Map((old?.messages ?? []).map(item => [item.id, item]));
          for (const item of incoming?.messages ?? []) {
            const normalized = message(item);
            messages.set(normalized.id, normalized);
          }
          save('conversations', { ...incoming, id: incoming?.id ?? incoming?.chatId, messages: [...messages.values()] }); break;
        }
        case 'record-event': save('events', payload.event); break;
        case 'schedule': {
          const item = schedule(payload.item);
          const old = next.schedules.find(record => record.id === item.id);
          if (!old && item.variationSeconds) {
            item.requestedFor = item.fireAt;
            const jitter = Math.round((Math.random() * 2 - 1) * item.variationSeconds * 1000);
            item.fireAt = new Date(Math.max(Date.now() + 1000, Date.parse(item.fireAt) + jitter)).toISOString();
          }
          save('schedules', item); break;
        }
        case 'claim-schedule': {
          const old = next.schedules.find(item => item.id === payload.id && !item.deleted);
          if (!old || old.status !== 'scheduled' || Date.parse(old.fireAt) > Date.now()
            || !next.settings.autoSendEnabled || old.sendMode !== 'automatic' || !old.skipIfNewMessage
            || old.chatId !== payload.chatId || old.incomingSnapshot !== payload.incomingSnapshot) throw new Error('Запись расписания нельзя выполнить.');
          if (payload.expected !== undefined) {
            keys(payload.expected, ['fireAt', 'text', 'updatedAt'], 'Ожидаемая запись');
            if (payload.expected.fireAt !== old.fireAt || payload.expected.text !== old.text || payload.expected.updatedAt !== old.updatedAt) throw new Error('Запись расписания изменилась перед выполнением.');
          }
          save('schedules', { ...old, status: 'firing' }); break;
        }
        case 'reschedule':
        case 'cancel-schedule':
        case 'complete-schedule': {
          const old = next.schedules.find(item => item.id === payload.id && !item.deleted);
          if (!old) throw new Error('Запись расписания не найдена.');
          if (old.status === 'firing' && ['reschedule', 'cancel-schedule'].includes(action)) throw new Error('Запись уже выполняется. Сначала проверьте результат в диалоге.');
          save('schedules', { ...old, fireAt: action === 'reschedule' ? payload.fireAt : old.fireAt,
            requestedFor: action === 'reschedule' ? payload.fireAt : old.requestedFor,
            status: action === 'reschedule' ? 'scheduled' : action === 'cancel-schedule' ? 'cancelled' : choice(payload.status, ['sent', 'failed', 'completed', 'ready'], 'completed'),
            error: payload.error ?? '' }); break;
        }
        case 'import': {
          let imported = payload.data;
          if (typeof imported === 'string') { if (imported.length > LIMITS.stateBytes) throw new RangeError('Файл слишком большой.'); imported = JSON.parse(imported); }
          if (plain(imported) && imported.format === 'replylab-library') { keys(imported, ['format', 'exportedAt', 'state'], 'Экспорт'); imported = imported.state; }
          imported = validateLibrary(imported);
          if (payload.mode === 'replace') { if (payload.confirmReplace !== true) throw new Error('Замена требует confirmReplace=true и предварительного экспорта.'); next = imported; }
          else if (payload.mode === undefined || payload.mode === 'merge') next = mergeLibraries(current, imported);
          else throw new TypeError('Неизвестный режим импорта.');
          break;
        }
        default: throw new TypeError('Неизвестное действие библиотеки: ' + action);
      }
      next = validateLibrary(next);
      await storageAdapter.set({ library: next });
      return copy(next);
    });
  }
  return { getState: () => dispatch('library'), dispatch };
}
