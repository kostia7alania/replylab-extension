import { canUseApp, suggestReplies } from './core.js';

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
