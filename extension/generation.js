import { canUseApp, suggestReplies } from './core.js';
import { renderStyle } from './library.js';
import { serverRequest, streamServer } from './server-client.js';

export function prepareTask(task, payload, options) {
  const state = options.library ?? { settings: options.settings ?? {}, styles: [], notes: {}, memories: [], conversations: [] };
  const settings = state.settings;
  const style = payload.styleId ? state.styles.find(item => item.id === payload.styleId && !item.deleted) : undefined;
  if (payload.styleId && !style) throw new Error('Выбранный стиль не найден.');
  let text = payload.text;
  let messages = payload.messages;
  let attachments = payload.attachments ?? [];
  if (task === 'assistant' && Array.isArray(messages) && messages.length) {
    const last = messages.at(-1);
    if (last.role !== 'user') throw new Error('Последнее сообщение должно принадлежать пользователю.');
    text = last.text ?? last.content;
    attachments = last.attachments ?? attachments;
    messages = messages.slice(0, -1).map(message => ({ role: message.role, text: message.text ?? message.content, attachments: message.attachments ?? [] }));
  }
  if (typeof text !== 'string' || !text.trim() || text.length > 10000) throw new Error('Текст запроса: от 1 до 10 000 символов.');
  const context = payload.context ? structuredClone(payload.context) : null;
  if (context && !payload.includePhotos) {
    context.photos = [];
    if (context.profile) context.profile.photos = [];
  }
  const memories = state.memories.filter(item => !item.deleted && item.enabled !== false);
  const notes = state.notes[context?.chatId]?.text ?? payload.notes ?? '';
  const transcript = (context?.messages ?? []).map(message => `${message.role}: ${message.text}`).join('\n');
  const systemPrompt = renderStyle(style?.prompt || payload.systemPrompt || settings.systemPrompt || '', {
    name: context?.profile?.name, bio: context?.profile?.bio, transcript, notes,
    memories: memories.map(item => item.text).join('\n'),
  });
  const count = payload.count ?? style?.suggestionCount ?? settings.suggestionCount ?? 3;
  if (!Number.isInteger(count) || count < 1 || count > 3) throw new Error('Количество ответов: от 1 до 3.');
  let historyMatches = [];
  if (style?.useHistory) {
    const words = new Set(text.toLocaleLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []);
    historyMatches = state.conversations.filter(item => !item.deleted).flatMap(conversation => conversation.messages
      .filter(message => ['user', 'outgoing'].includes(message.role))
      .map(message => ({ text: message.text, score: [...words].filter(word => message.text.toLocaleLowerCase().includes(word)).length })))
      .filter(item => item.score).sort((a, b) => b.score - a.score).slice(0, 10).map(({ text }) => text);
  }
  const photos = payload.includePhotos ? (payload.context?.photos ?? payload.context?.profile?.photos ?? []).slice(0, 8) : [];
  if (attachments.length + photos.length > 8) throw new Error('Максимум 8 вложений и фотографий в одном запросе.');
  return { text: text.trim(), tone: payload.tone, context: historyMatches.length ? { ...context, historyMatches } : context,
    messages, attachments: [...attachments, ...photos],
    count, model: payload.model || style?.model || settings[task === 'replies' ? 'suggestionModel' : 'assistantModel'] || options.model,
    provider: payload.provider || settings[task === 'replies' ? 'suggestionProvider' : 'assistantProvider'] || settings.provider || 'openai', systemPrompt, memories, notes,
    language: payload.targetLanguage ?? payload.language ?? settings.language ?? 'ru',
    temperature: payload.temperature ?? style?.temperature, maxTokens: payload.maxTokens ?? style?.maxTokens,
    ...(style ? { style: { ...style, prompt: systemPrompt } } : {}) };
}

export async function generateTask(task, payload, options) {
  if (!canUseApp(options.user)) throw new Error('Включите локальный доступ кодом REPLYLAB-LOCAL.');
  const input = prepareTask(task, payload, options);
  if ((options.mode ?? 'mock') === 'mock') {
    if (options.signal?.aborted) throw new DOMException('Запрос отменён.', 'AbortError');
    if (task === 'replies') return { replies: suggestReplies(input.text, input.tone).slice(0, input.count) };
    if (task === 'translate') throw new Error('Для настоящего перевода выберите свой GPT в настройках.');
    const text = 'Локальный пример. Реальная модель в этом режиме не вызывается.\n\n' + input.text.slice(0, 600);
    options.onDelta?.(text);
    return task === 'create-style' ? { style: { name: 'Локальный пример', prompt: text } } : { text };
  }
  if (options.mode !== 'gpt') throw new Error('Выберите источник ответов в настройках.');
  if (typeof input.model !== 'string' || !input.model.trim()) throw new Error('Укажите модель выбранного провайдера.');
  if (options.onDelta) return streamServer({ ...input, task }, options, event => options.onDelta(event.text));
  return serverRequest(task === 'replies' ? '/replies' : '/assistant', { ...options, method: 'POST', body: { ...input, task } });
}

export async function generateReplies({ text, tone }, { user, mode = 'mock', model = '', canConnect = false, fetchImpl = fetch }) {
  if (!canUseApp(user)) throw new Error('Включите локальный доступ кодом REPLYLAB-LOCAL в настройках ReplyLab.');
  const localReplies = suggestReplies(text, tone);
  if (mode === 'mock') return localReplies;
  if (mode !== 'gpt') throw new Error('Выберите источник ответов в настройках ReplyLab.');
  if (!canConnect) throw new Error('Разрешите локальный коннектор в настройках ReplyLab.');
  if (typeof model !== 'string' || !model.trim()) throw new Error('Укажите модель в настройках ReplyLab.');
  const response = await fetchImpl('http://127.0.0.1:4318/replies', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-ReplyLab': '1' },
    body: JSON.stringify({ text, tone, model: model.trim() }),
    redirect: 'error', signal: AbortSignal.timeout(45000),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `Ошибка коннектора: ${response.status}`);
  if (!Array.isArray(data.replies) || data.replies.length !== 3 || data.replies.some((reply) =>
    typeof reply?.text !== 'string' || !reply.text.trim() || reply.text.length > 2000 ||
    typeof reply.reason !== 'string' || reply.reason.length > 600)) throw new Error('Коннектор вернул неверный формат.');
  return data.replies.map(({ text, reason }) => ({ text, reason }));
}
