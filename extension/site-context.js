export function platformFor(loc) {
  const hostname = loc?.hostname ?? '';
  if (hostname === 'tinder.com' || hostname.endsWith('.tinder.com')) return 'tinder';
  return hostname === 'web.whatsapp.com' ? 'whatsapp' : null;
}

const text = value => typeof value === 'string' ? value.trim() : '';
const identifier = value => typeof value === 'string' || typeof value === 'number' ? String(value) : '';
const iso = value => {
  if (value === null || value === undefined || value === '') return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
};
export function photoUrl(value) {
  try {
    const url = new URL(value);
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}

export function objectIdTimestamp(id, now = Date.now()) {
  if (typeof id !== 'string' || !/^[a-f\d]{24}$/i.test(id)) return null;
  const timestamp = Number.parseInt(id.slice(0, 8), 16) * 1000;
  return timestamp >= Date.UTC(2000, 0, 1) && timestamp <= now ? new Date(timestamp).toISOString() : null;
}

export function normalizeProfile(raw = {}, now = Date.now()) {
  raw = raw && typeof raw === 'object' ? raw : {};
  const id = identifier(raw._id ?? raw.id);
  const photos = [...new Set((Array.isArray(raw.photos) ? raw.photos : []).flatMap(photo => {
    if (typeof photo === 'string') return [photo];
    return [photo?.url, ...(Array.isArray(photo?.processedFiles) ? photo.processedFiles : []).map(file => file?.url)];
  }).map(photoUrl).filter(Boolean))];
  return {
    id,
    name: text(raw.name ?? raw.personName),
    bio: text(raw.bio),
    photos,
    birthDate: iso(raw.birth_date ?? raw.birthDate),
    age: Number.isFinite(raw.age) && raw.age >= 18 && raw.age <= 120 ? raw.age : null,
    city: text(typeof raw.city === 'object' ? raw.city?.name : raw.city),
    distanceKm: Number.isFinite(raw.distance_mi) ? Math.round(raw.distance_mi * 1.609344) : null,
    idTimestamp: objectIdTimestamp(id, now),
  };
}

function tinderMessage(raw, selfId) {
  if (!raw || typeof raw !== 'object') return null;
  const body = text(raw.message ?? raw.text ?? raw.body);
  const from = identifier(raw.from ?? raw.fromId);
  const to = identifier(raw.to ?? raw.toId);
  return { id: identifier(raw._id ?? raw.id), role: selfId && from === selfId ? 'user' : selfId && to === selfId ? 'assistant' : 'unknown',
    text: body, createdAt: iso(raw.sent_date ?? raw.timestamp ?? raw.createdAt), attachment: body ? null : text(raw.type) || 'unknown' };
}

export function conversationFromTinder(state, route, now = Date.now()) {
  const chatId = identifier(state?.routing?.params?.matchId);
  if (!chatId || !/^\/app\/messages\//.test(route)) return null;
  if (state.routing.pathname && state.routing.pathname !== route) return null;
  try { if (decodeURIComponent(route.split('/')[3] ?? '') !== chatId) return null; } catch { return null; }
  const match = state?.entities?.matches?.[chatId];
  if (!match) return null;
  const rawProfile = typeof match.person === 'object' ? match.person : state.entities.profiles?.[match.person];
  const rawMessages = (Array.isArray(match.messages) ? match.messages : []).map(value => typeof value === 'object' ? value : state.entities.messages?.[value]).filter(Boolean);
  const selfId = identifier(state?.profile?.user?._id);
  const profile = normalizeProfile(rawProfile, now);
  const messages = rawMessages.slice(-500).map(message => tinderMessage(message, selfId)).filter(Boolean);
  const omittedMessages = Math.max(0, (match.loadedMessageCount ?? rawMessages.length) - messages.length);
  return { chatId, accountId: selfId, platform: 'tinder', route, profile, photos: profile.photos, messages,
    currentReliable: Boolean(selfId && state.routing.pathname === route && messages.every(message => message.role !== 'unknown')),
    partial: true, source: 'loaded-app-state', omittedMessages,
    title: profile.name || 'Открытый диалог' };
}

export function conversationFromWhatsApp(raw, route) {
  const chatId = identifier(raw?.id);
  if (!chatId) return null;
  const profile = normalizeProfile({ id: raw.personId, name: raw.name ?? raw.personName,
    photos: raw.personProfilePicUrl ? [raw.personProfilePicUrl] : [] });
  const loaded = Array.isArray(raw.messages) ? raw.messages : [];
  return { chatId, accountId: '', platform: 'whatsapp', route, profile, photos: profile.photos,
    messages: loaded.slice(-500).map(message => ({ id: identifier(message.id), role: message.isFromMe === true ? 'user' : message.isFromMe === false ? 'assistant' : 'unknown',
      text: text(message.body), createdAt: iso(typeof message.ts_sec === 'number' ? message.ts_sec * 1000 : message.createdAt),
      attachment: message.type && message.type !== 'chat' ? text(message.type) : null })),
    currentReliable: loaded.every(message => typeof message.isFromMe === 'boolean'),
    partial: true, source: 'loaded-app-state', omittedMessages: Math.max(0, (raw.loadedMessageCount ?? loaded.length) - 500), title: profile.name || 'Открытый диалог' };
}

export function normalizeSiteSnapshot(raw, loc) {
  const platform = platformFor(loc);
  if (!platform || raw?.platform !== platform || raw.route !== loc.pathname) return null;
  if (platform === 'tinder') {
    const conversation = conversationFromTinder(raw.state, loc.pathname);
    const cardId = raw.state?.recs?.recs?.queues?.main?.[0];
    const card = raw.state?.entities?.profiles?.[cardId];
    return { conversation, profile: card ? normalizeProfile(card) : null, source: 'loaded-app-state', route: loc.pathname };
  }
  return { conversation: conversationFromWhatsApp(raw.chat, loc.pathname), profile: null, source: 'loaded-app-state', route: loc.pathname };
}

export function incomingSnapshot(conversation) {
  const last = [...(conversation?.messages ?? [])].reverse().find(message => message.role === 'assistant' || message.role === 'unknown');
  return JSON.stringify([conversation?.platform ?? '', conversation?.accountId ?? '', conversation?.chatId ?? '',
    last ? [last.id ?? '', last.text ?? '', last.createdAt ?? '', last.role] : []]);
}

export function canAutoSendContext(conversation) {
  return Boolean(conversation?.accountId && conversation?.source === 'loaded-app-state' && conversation.currentReliable === true
    && conversation.omittedMessages === 0 && conversation.messages?.length
    && conversation.messages.every(message => ['user', 'assistant'].includes(message.role))
    && conversation.messages.some(message => message.role === 'assistant'));
}

export function transcript(conversation) {
  const header = [conversation?.profile?.name || 'Диалог', conversation?.platform || '', conversation?.partial ? 'Только загруженная часть' : ''].filter(Boolean).join(' · ');
  return [header, ...(conversation?.messages ?? []).map(message => `${message.createdAt ? `[${message.createdAt}] ` : ''}${message.role === 'user' ? 'Вы' : message.role === 'unknown' ? 'Автор неизвестен' : conversation.profile?.name || 'Собеседник'}: ${message.text || `[${message.attachment || 'вложение'}]`}`)].join('\n');
}

export function validGeo(value) {
  return Boolean(value?.enabled === true && Number.isFinite(value.latitude) && Math.abs(value.latitude) <= 90
    && Number.isFinite(value.longitude) && Math.abs(value.longitude) <= 180
    && Number.isFinite(value.accuracy ?? 100) && (value.accuracy ?? 100) > 0 && (value.accuracy ?? 100) <= 100000);
}

export function styleConditions(conversation, now = Date.now()) {
  const messages = conversation?.messages ?? [];
  if (!messages.length) return ['opener', 'empty'];
  const last = messages[messages.length - 1];
  if (last.role === 'assistant' || last.role === 'incoming') return ['incoming'];
  const timestamp = typeof last.createdAt === 'string' ? Date.parse(last.createdAt) : Number.NaN;
  return (last.role === 'user' || last.role === 'outgoing') && Number.isFinite(timestamp)
    && now - timestamp > 24 * 60 * 60 * 1000 ? ['stale'] : [];
}

export function isStyleEligible(style, conversation, now = Date.now()) {
  if (!style || style.deleted) return false;
  const available = styleConditions(conversation, now);
  return (style.conditions ?? ['opener', 'incoming', 'stale', 'empty']).some(condition => available.includes(condition));
}

export function instagramLinks(bio) {
  const found = new Set();
  const reserved = new Set(['p', 'reel', 'reels', 'stories', 'explore', 'accounts', 'direct', 'about']);
  for (const match of String(bio ?? '').matchAll(/(?<![a-zA-Z0-9._/-])(?:(?:https?:\/\/)?(?:www\.)?instagram\.com\/([a-zA-Z0-9._]{1,30})(?=[/?#\s]|$)|(?:instagram|insta|инстаграм|инста)\s*[:—-]?\s*@?([a-zA-Z0-9._]{1,30})(?=[\s,;!?]|$))/gi)) {
    const handle = match[1] || match[2];
    if (handle && !reserved.has(handle.toLowerCase()) && !/^\.+$/.test(handle)) found.add(handle);
  }
  return [...found].map(handle => ({ handle, url: `https://www.instagram.com/${encodeURIComponent(handle)}/` }));
}

export function languageHint(value) {
  const sample = String(value ?? '').toLowerCase().replace(/https?:\/\/\S+/g, ' ');
  if (/[а-яё]/.test(sample)) return { code: 'ru', basis: 'script', heuristic: true };
  const words = {
    de: 'hallo|danke|ich|und|nicht|wie', fr: 'bonjour|merci|je|avec|pour|vous', es: 'hola|gracias|quiero|cómo|para|estoy',
    pt: 'olá|obrigado|obrigada|você|estou|muito', da: 'hej|tak|jeg|ikke|hvad|og', sv: 'hej|tack|jag|inte|vad|och',
    fi: 'hei|kiitos|minä|mitä|että|hyvää', lt: 'labas|ačiū|aš|kaip|labai|kad', pl: 'cześć|dziękuję|jestem|jak|nie|bardzo',
    en: 'hello|thanks|thank|you|and|with',
  };
  const scores = Object.entries(words).map(([code, terms]) => ({ code, score: [...sample.matchAll(new RegExp(`(?:^|[^\\p{L}])(?:${terms})(?=$|[^\\p{L}])`, 'gu'))].length }))
    .sort((a, b) => b.score - a.score);
  return scores[0].score >= 2 && scores[0].score > scores[1].score ? { code: scores[0].code, basis: 'words', heuristic: true } : { code: null, basis: 'insufficient', heuristic: true };
}

export function renderedContext(doc, loc) {
  const platform = platformFor(loc);
  if (!platform) return null;
  const root = platform === 'whatsapp' ? doc.querySelector('#main') : doc.querySelector('main, [role="main"]');
  if (!root) return null;
  let routeId = '';
  try { routeId = platform === 'tinder' && /^\/app\/messages\//.test(loc.pathname) ? decodeURIComponent(loc.pathname.split('/')[3] ?? '') : ''; } catch { return null; }
  const chatId = root.getAttribute('data-chat-id') || routeId;
  if (!chatId) return null;
  const nodes = [...root.querySelectorAll('[data-message-id], [data-testid="message"], [role="log"] > [role="listitem"], [data-pre-plain-text]')];
  const unique = nodes.filter(node => !nodes.some(other => other !== node && other.contains(node)));
  const messages = unique.slice(-500).map(node => ({ id: node.getAttribute('data-message-id') || node.getAttribute('data-id') || '',
    role: node.getAttribute('data-outgoing') === 'true' || node.classList.contains('message-out') || node.closest('.message-out') ? 'user'
      : node.getAttribute('data-outgoing') === 'false' || node.classList.contains('message-in') || node.closest('.message-in') ? 'assistant' : 'unknown',
    text: node.textContent.trim(), createdAt: iso(node.querySelector('time')?.getAttribute('datetime')) }));
  const heading = root.querySelector('header [title], header h1, header h2, [data-testid="profile-name"]');
  const profile = normalizeProfile({ name: heading?.getAttribute('title') || heading?.textContent || '' });
  return { chatId, platform, route: loc.pathname, profile, photos: [], messages,
    currentReliable: false, partial: true, source: 'rendered-dom', omittedMessages: Math.max(0, unique.length - 500), title: profile.name || 'Открытый диалог' };
}
