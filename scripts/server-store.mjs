import { mkdir, readFile, rename, open, lstat, chmod, unlink } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { validateLibrary, mergeLibraries } from '../extension/library.js';
import { aggregate90days } from '../extension/analytics.js';

const COLLECTIONS = ['styles', 'memories', 'assistantChats', 'conversations', 'events', 'schedules'];
const FORBIDDEN = new Set(['__proto__', 'prototype', 'constructor']);
const MAX_BYTES = 8 * 1024 * 1024;
export class StoreConflictError extends Error { constructor(message) { super(message); this.status = 409; } }
export class StoreNotFoundError extends Error { constructor(message) { super(message); this.status = 404; } }

export function emptyState() {
  return { version: 1, styles: [], notes: {}, memories: [], assistantChats: [], conversations: [], events: [], schedules: [], settings: {} };
}

function checked(value, depth = 0) {
  if (depth > 16) throw new TypeError('Слишком глубокая структура данных.');
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return;
  if (typeof value === 'number' && Number.isFinite(value)) return;
  if (Array.isArray(value)) { if (value.length > 20000) throw new RangeError('Слишком много записей.'); value.forEach(item => checked(item, depth + 1)); return; }
  if (typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) throw new TypeError('Нужны JSON-данные.');
  for (const [key, item] of Object.entries(value)) {
    if (FORBIDDEN.has(key)) throw new TypeError('Недопустимое поле данных.');
    checked(item, depth + 1);
  }
}

export function validateState(input) {
  const value = input?.state ?? input;
  checked(value);
  if (!value || Array.isArray(value) || typeof value !== 'object' || (value.version !== undefined && value.version !== 1)) throw new TypeError('Нужна версия данных 1.');
  const allowed = new Set(['version', 'revision', 'updatedAt', ...COLLECTIONS, 'notes', 'settings']);
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new TypeError(`Неизвестный раздел: ${key}`);
  if (Buffer.byteLength(JSON.stringify(value)) > MAX_BYTES) throw new RangeError('Данные больше 8 MiB.');
  const result = emptyState();
  for (const name of COLLECTIONS) {
    if (value[name] === undefined) continue;
    if (!Array.isArray(value[name])) throw new TypeError(`Раздел ${name} должен быть массивом.`);
    const seen = new Set();
    result[name] = value[name].map(record => {
      if (!record || Array.isArray(record) || typeof record !== 'object' || typeof record.id !== 'string' || !record.id || record.id.length > (name === 'conversations' ? 1000 : 200) || seen.has(record.id)) throw new TypeError(`Некорректный или повторяющийся id: ${name}`);
      seen.add(record.id);
      for (const field of ['createdAt', 'updatedAt']) if (record[field] !== undefined && !Number.isFinite(Date.parse(record[field]))) throw new TypeError(`Некорректная дата: ${name}.${field}`);
      if (record.messages !== undefined && !Array.isArray(record.messages)) throw new TypeError('История сообщений должна быть массивом.');
      if (name === 'assistantChats' && record.messages?.length > 40) throw new RangeError('Сначала экспортируйте историю: максимум 40 сообщений на сессию.');
      return structuredClone(record);
    });
    if (name === 'assistantChats' && result[name].filter(record => !record.deleted).length > 20) throw new RangeError('Сначала экспортируйте историю: максимум 20 сессий.');
  }
  if (value.notes !== undefined) {
    if (!value.notes || Array.isArray(value.notes) || typeof value.notes !== 'object') throw new TypeError('Заметки должны быть словарём.');
    for (const [id, note] of Object.entries(value.notes)) {
      if (!id || id.length > 1000 || !note || typeof note.text !== 'string' || note.text.length > 100000 || (note.updatedAt !== undefined && !Number.isFinite(Date.parse(note.updatedAt)))) throw new TypeError('Некорректная заметка.');
    }
    result.notes = structuredClone(value.notes);
  }
  if (value.settings !== undefined) {
    if (!value.settings || Array.isArray(value.settings) || typeof value.settings !== 'object') throw new TypeError('Настройки должны быть объектом.');
    for (const key of Object.keys(value.settings)) if (/^(?:apiKey|accessToken|refreshToken|authorization|password|secret)$/i.test(key)) throw new TypeError('Ключи API хранятся отдельно от синхронизации.');
    result.settings = structuredClone(value.settings);
  }
  return validateLibrary(result);
}

const timestamp = record => Date.parse(record?.updatedAt ?? record?.createdAt ?? '') || 0;
const resourceId = value => {
  if (typeof value !== 'string' || !/^[\p{L}\p{N}_.:-]{1,200}$/u.test(value) || FORBIDDEN.has(value)) throw new TypeError('Некорректный ID записи.');
  return value;
};
function templateRecord(value) {
  checked(value);
  const allowed = new Set(['id', 'name', 'prompt', 'scope', 'version', 'createdAt', 'updatedAt']);
  if (!value || Array.isArray(value) || Object.keys(value).some(key => !allowed.has(key))) throw new TypeError('Неизвестное поле шаблона.');
  if (typeof value.name !== 'string' || !value.name.trim() || value.name.length > 120 || typeof value.prompt !== 'string' || !value.prompt.trim() || value.prompt.length > 20000) throw new TypeError('Нужны имя и инструкция шаблона до 20 000 символов.');
  if (!['reply', 'assistant-base', 'assistant-chat', 'assistant-profile'].includes(value.scope)) throw new TypeError('Неизвестная область шаблона.');
  if (!Number.isSafeInteger(value.version) || value.version < 1) throw new TypeError('Некорректная версия шаблона.');
  for (const field of ['createdAt', 'updatedAt']) if (!Number.isFinite(Date.parse(value[field]))) throw new TypeError('Некорректная дата шаблона.');
  return { id: resourceId(value.id), name: value.name.trim(), prompt: value.prompt.trim(), scope: value.scope, version: value.version, createdAt: new Date(value.createdAt).toISOString(), updatedAt: new Date(value.updatedAt).toISOString() };
}
export function mergeStates(base, incoming) {
  const left = validateState(base); const right = validateState(incoming);
  const rawIncoming = incoming?.state ?? incoming;
  const combined = mergeLibraries(left, right);
  for (const name of COLLECTIONS) {
    left[name] = combined[name];
  }
  for (const [id, note] of Object.entries(right.notes)) if (!left.notes[id] || timestamp(note) >= timestamp(left.notes[id])) left.notes[id] = note;
  if (Object.hasOwn(rawIncoming, 'settings') && timestamp(rawIncoming.settings) >= timestamp(left.settings)) {
    for (const key of Object.keys(rawIncoming.settings)) left.settings[key] = right.settings[key];
  }
  return validateState(left);
}

export function createStore({ directory = '.replylab', now = () => Date.now() } = {}) {
  const dir = resolve(directory); const filename = join(dir, 'state.json');
  let queue = Promise.resolve();
  async function load() {
    try {
      const stat = await lstat(filename); if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Недопустимый файл хранилища.');
      const data = JSON.parse(await readFile(filename, 'utf8'));
      return { state: validateState(data.state), revision: Number.isSafeInteger(data.revision) ? data.revision : 0, shares: Array.isArray(data.shares) ? data.shares : [], claims: data.claims && typeof data.claims === 'object' && !Array.isArray(data.claims) ? data.claims : {}, templates: (data.templates ?? []).map(templateRecord) };
    } catch (error) { if (error.code === 'ENOENT') return { state: emptyState(), revision: 0, shares: [], claims: {}, templates: [] }; throw error; }
  }
  async function save(data) {
    const serialized = JSON.stringify(data);
    if (Buffer.byteLength(serialized) > 64 * 1024 * 1024) throw new RangeError('Хранилище больше 64 MiB. Экспортируйте данные и удалите ненужные публичные ссылки.');
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const stat = await lstat(dir); if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Недопустимая папка хранилища.');
    await chmod(dir, 0o700);
    const temporary = join(dir, `.state-${randomUUID()}.tmp`);
    const file = await open(temporary, 'wx', 0o600);
    try { await file.writeFile(serialized); await file.sync(); }
    finally { await file.close(); }
    try { await rename(temporary, filename); }
    catch (error) { await unlink(temporary).catch(() => {}); throw error; }
  }
  function transaction(operation) {
    const result = queue.then(async () => {
      const data = await load(); const value = await operation(data);
      data.revision++; await save(data); return value === undefined ? { state: data.state, revision: data.revision } : { ...value, revision: data.revision };
    });
    queue = result.catch(() => {}); return result;
  }
  return {
    async read() { await queue; const { state, revision } = await load(); return { state, revision }; },
    merge(input) { validateState(input); return transaction(data => { data.state = mergeStates(data.state, input); }); },
    async catalog() { const { state, revision } = await this.read(); return { items: state.styles.filter(item => !item.deleted && item.shared), revision, source: 'own-server' }; },
    saveCatalog(value, id) {
      checked(value);
      return transaction(data => {
        const selectedId = resourceId(id ?? value.id ?? randomUUID());
        const previous = data.state.styles.find(item => item.id === selectedId);
        if (id && (!previous || previous.deleted || !previous.shared)) throw new StoreNotFoundError('Стиль каталога не найден.');
        const date = new Date(now()).toISOString();
        const item = validateLibrary({ ...emptyState(), styles: [{ ...previous, ...value, id: selectedId, shared: true, deleted: false, createdAt: previous?.createdAt ?? date, updatedAt: date }] }).styles[0];
        if (!item.prompt.trim()) throw new TypeError('Инструкция стиля не может быть пустой.');
        data.state = validateState({ ...data.state, styles: [...data.state.styles.filter(record => record.id !== item.id), item] });
        return { item };
      });
    },
    deleteCatalog(id) {
      resourceId(id);
      return transaction(data => {
        const item = data.state.styles.find(item => item.id === id && !item.deleted && item.shared);
        if (!item) throw new StoreNotFoundError('Стиль каталога не найден.');
        data.state = validateState({ ...data.state, styles: data.state.styles.map(record => record.id === id ? { id, deleted: true, createdAt: record.createdAt, updatedAt: new Date(now()).toISOString() } : record) });
        return { deleted: true };
      });
    },
    async templates() { await queue; const data = await load(); return { items: data.templates, revision: data.revision, source: 'own-server' }; },
    saveTemplate(value, id) {
      checked(value);
      return transaction(data => {
        const selectedId = resourceId(id ?? value.id ?? randomUUID());
        const previous = data.templates.find(item => item.id === selectedId);
        if (id && !previous) throw new StoreNotFoundError('Шаблон не найден.');
        if (!previous && data.templates.length >= 1000) throw new RangeError('Максимум 1000 шаблонов.');
        const date = new Date(now()).toISOString();
        const item = templateRecord({ ...previous, ...value, id: selectedId, version: (previous?.version ?? 0) + 1, createdAt: previous?.createdAt ?? date, updatedAt: date });
        data.templates = [...data.templates.filter(record => record.id !== selectedId), item]; return { item };
      });
    },
    deleteTemplate(id) {
      resourceId(id);
      return transaction(data => {
        if (!data.templates.some(item => item.id === id)) throw new StoreNotFoundError('Шаблон не найден.');
        data.templates = data.templates.filter(item => item.id !== id); return { deleted: true };
      });
    },
    async searchPastReplies({ query, current_account_only = true, accountId, platform, limit = 10 } = {}) {
      const phrase = normalize(query);
      if (!phrase || phrase.length > 500 || typeof current_account_only !== 'boolean' || !Number.isInteger(limit) || limit < 1 || limit > 20) throw new TypeError('Нужен поисковый запрос до 500 символов и лимит 1–20.');
      if (current_account_only && (typeof accountId !== 'string' || !accountId)) throw new TypeError('Для поиска нужен подтверждённый аккаунт.');
      const words = [...new Set(phrase.match(/[\p{L}\p{N}]+/gu) ?? [])].slice(0, 30);
      const { state } = await this.read(); const found = [];
      for (const conversation of state.conversations.filter(item => !item.deleted && (!current_account_only || item.accountId === accountId) && (!platform || item.platform === platform))) {
        let incoming = '';
        for (const message of conversation.messages) {
          if (['assistant', 'incoming'].includes(message.role)) { incoming = message.text; continue; }
          if (!['user', 'outgoing'].includes(message.role)) { incoming = ''; continue; }
          const haystack = normalize(incoming + '\n' + message.text);
          const score = haystack.includes(phrase) ? words.length + 1 : words.filter(word => haystack.includes(word)).length;
          if (score) found.push({ score, conversationId: conversation.id, chatId: conversation.chatId, accountId: conversation.accountId, platform: conversation.platform,
            theirText: incoming.slice(0, 5000), myReply: message.text.slice(0, 5000), sentAt: message.createdAt ?? null, messageId: message.id,
            partial: conversation.partial || !incoming || incoming.length > 5000 || message.text.length > 5000 });
        }
      }
      return found.sort((a, b) => b.score - a.score || (Date.parse(b.sentAt) || 0) - (Date.parse(a.sentAt) || 0)).slice(0, limit).map(({ score, ...item }) => item);
    },
    async search(query) {
      const text = normalize(query); if (!text || text.length > 500) throw new TypeError('Введите поисковый запрос до 500 символов.');
      const { state } = await this.read(); const results = [];
      for (const conversation of state.conversations.filter(item => !item.deleted)) {
        for (const message of conversation.messages ?? []) if (normalize(message.text ?? '').includes(text)) results.push({ type: 'message', id: message.id, conversationId: conversation.id, title: conversation.title ?? '', text: String(message.text ?? '') });
      }
      for (const [id, note] of Object.entries(state.notes)) if (!note.deleted && normalize(note.text).includes(text)) results.push({ type: 'note', id, conversationId: id, text: note.text });
      return results;
    },
    createShare(conversation, ttlHours = 24) {
      checked(conversation);
      if (!conversation || typeof conversation !== 'object' || !Array.isArray(conversation.messages) || Buffer.byteLength(JSON.stringify(conversation)) > 1000000) throw new TypeError('Нужен диалог до 1 MiB.');
      if (!Number.isFinite(ttlHours) || ttlHours < 1 / 60 || ttlHours > 24 * 365) throw new RangeError('Срок ссылки: от минуты до года.');
      return transaction(data => {
        const token = randomBytes(24).toString('base64url'); const expiresAt = new Date(now() + ttlHours * 3600000).toISOString();
        data.shares = data.shares.filter(item => Date.parse(item.expiresAt) > now());
        if (data.shares.length >= 1000) throw new RangeError('Удалите старые ссылки перед созданием новых.');
        data.shares.push({ token, expiresAt, conversation: structuredClone(conversation) }); return { token, expiresAt };
      });
    },
    async share(token) { await queue; const data = await load(); return data.shares.find(item => item.token === token && Date.parse(item.expiresAt) > now()) ?? null; },
    deleteShare(token) { return transaction(data => { const length = data.shares.length; data.shares = data.shares.filter(item => item.token !== token); return { deleted: data.shares.length !== length }; }); },
    claimSchedule({ id, fireAt, deviceId, incomingSnapshot = '', expectedText, expectedUpdatedAt }) {
      if (typeof id !== 'string' || !id || id.length > 200 || typeof deviceId !== 'string' || !deviceId || deviceId.length > 200 || !Number.isFinite(Date.parse(fireAt)) || typeof incomingSnapshot !== 'string' || incomingSnapshot.length > 50000) throw new TypeError('Некорректный запрос захвата расписания.');
      const scheduledAt = new Date(fireAt).toISOString();
      return transaction(data => {
        const key = `${id}\u0000${scheduledAt}`;
        const item = data.state.schedules.find(record => record.id === id && !record.deleted);
        if (Object.hasOwn(data.claims, key) || !item || item.status !== 'scheduled' || new Date(item.fireAt).toISOString() !== scheduledAt || Date.parse(scheduledAt) > now() || (item.incomingSnapshot ?? '') !== incomingSnapshot) throw new StoreConflictError('Расписание уже захвачено, изменено или ещё не наступило.');
        if ((expectedText !== undefined && expectedText !== item.text) || (expectedUpdatedAt !== undefined && expectedUpdatedAt !== item.updatedAt)) throw new StoreConflictError('Версия записи расписания изменилась.');
        if (Object.keys(data.claims).length >= 20000) throw new StoreConflictError('Достигнут лимит журнала захватов. Требуется проверенное архивирование оператором.');
        const claimedAt = new Date(now()).toISOString();
        data.claims[key] = { deviceId, claimedAt };
        item.status = 'firing'; item.updatedAt = claimedAt;
        data.state = validateState(data.state);
        return { claimed: true, item: structuredClone(data.state.schedules.find(record => record.id === id)) };
      });
    },
    async analytics(timeZone = 'UTC') {
      const { state } = await this.read();
      return aggregate90days(state.events, timeZone, now());
    },
  };
}

function normalize(value) { return String(value ?? '').normalize('NFKC').toLocaleLowerCase().replace(/ё/g, 'е').trim(); }
