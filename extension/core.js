export const TEST_CODE = 'REPLYLAB-LOCAL';

const DAY = 24 * 60 * 60 * 1000;

export function fixture(scenario, now = Date.now()) {
  if (scenario === 'signed_out') return null;
  if (!['active', 'trial', 'expired'].includes(scenario)) {
    throw new RangeError('Неизвестный локальный сценарий.');
  }
  if (!Number.isFinite(now)) throw new TypeError('Некорректное время сценария.');

  return {
    displayName: 'Локальный тест',
    canUseApp: scenario !== 'expired',
    isOnTrial: scenario === 'trial',
    canUseManagedAI: scenario !== 'expired',
    trialEndsAt: scenario === 'active' ? null : new Date(now + (scenario === 'trial' ? 7 * DAY : -DAY)).toISOString(),
  };
}

export function activate(code, now = Date.now()) {
  if (typeof code !== 'string' || code.trim().toUpperCase() !== TEST_CODE) {
    throw new Error('Неверный локальный тестовый код.');
  }
  return fixture('active', now);
}

export function canUseApp(user) {
  return Boolean(user?.canUseApp || user?.isOnTrial);
}

const REPLIES = {
  friendly: [
    { text: 'Звучит интересно! Расскажешь чуть подробнее?', reason: 'Поддерживает разговор и оставляет простой повод ответить.' },
    { text: 'А что тебе в этом больше всего нравится?', reason: 'Открытый вопрос помогает узнать собеседника.' },
    { text: 'Мне нравится твой настрой 🙂 Как прошёл день?', reason: 'Тёплый ответ без лишнего давления.' },
  ],
  playful: [
    { text: 'Интригуешь 🙂 Продолжай, я слушаю.', reason: 'Добавляет лёгкую игру и приглашает продолжить.' },
    { text: 'Кажется, у этой истории должно быть продолжение 😄', reason: 'Ненавязчивая шутка поддерживает интерес.' },
    { text: 'Теперь мне любопытно: какой самый неожиданный факт о тебе?', reason: 'Помогает перейти к лёгкой новой теме.' },
  ],
  concise: [
    { text: 'Расскажи подробнее 🙂', reason: 'Короткое приглашение продолжить.' },
    { text: 'А тебе как?', reason: 'Возвращает инициативу собеседнику.' },
    { text: 'Звучит здорово!', reason: 'Краткая доброжелательная реакция.' },
  ],
};

export function suggestReplies(text, tone = 'friendly') {
  if (typeof text !== 'string') throw new TypeError('Введите текст сообщения.');
  if (!text.trim()) throw new Error('Введите непустое сообщение.');
  if (text.length > 10000) throw new RangeError('Сообщение длиннее 10 000 символов. Сократите его вручную.');
  const key = Object.hasOwn(REPLIES, tone) ? tone : 'friendly';
  return REPLIES[key].map(reply => ({ ...reply }));
}
