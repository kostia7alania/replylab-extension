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
  let richPartial = raw.richPartial !== false;
  const bounded = (value, max) => { const result = text(value); if (result.length > max) richPartial = true; return result.slice(0, max); };
  const list = (value, max) => { if (!Array.isArray(value)) return []; if (value.length > max) richPartial = true; return value.slice(0, max); };
  const id = bounded(identifier(raw._id ?? raw.id), 150);
  const photos = [...new Set(list(raw.photos, 20).filter(photo => !photo?.is_video && photo?.type !== 'video').map(photo =>
    typeof photo === 'string' ? photo : photo?.processedFiles?.[0]?.url || photo?.url).map(photoUrl).filter(Boolean))];
  const interests = list(raw.interests ?? raw.user_interests?.selected_interests, 100)
    .map(value => bounded(typeof value === 'string' ? value : value?.name, 200)).filter(Boolean);
  const descriptors = list(raw.descriptors ?? raw.selected_descriptors, 100).map(value => {
    const measurement = value?.measurable_selection;
    const selected = Array.isArray(value?.choice_selections) ? value.choice_selections.map(choice => text(choice?.name)).filter(Boolean).join(', ') : '';
    const measured = measurement && (typeof measurement.value === 'number' || typeof measurement.value === 'string')
      ? [String(measurement.value), text(measurement.unit_of_measure)].filter(Boolean).join(' ') : '';
    return { id: bounded(identifier(value?.id), 150), name: bounded(value?.name, 200),
      type: value?.type == null ? null : bounded(value.type, 100), value: bounded(value?.value ?? (measured || selected), 1000) };
  });
  const userPrompts = list(raw.userPrompts ?? raw.user_prompts?.prompts, 50).map(value => ({
    id: bounded(identifier(value?.id), 150), question: bounded(value?.question ?? value?.question_text, 1000), answer: bounded(value?.answer ?? value?.answer_text, 10000),
  }));
  const track = raw.spotify?.themeTrack ?? raw.spotify?.spotify_theme_track;
  const themeTrack = track && typeof track === 'object' ? { name: bounded(track.name, 300),
    artists: list(track.artists, 30).map(artist => bounded(typeof artist === 'string' ? artist : artist?.name, 200)).filter(Boolean) } : null;
  const profile = {
    id, name: bounded(raw.name ?? raw.personName, 150), bio: bounded(raw.bio, 10000), photos,
    birthDate: iso(raw.birth_date ?? raw.birthDate),
    age: Number.isFinite(raw.age) && raw.age >= 18 && raw.age <= 120 ? raw.age : null,
    city: bounded(typeof raw.city === 'object' ? raw.city?.name : raw.city, 150),
    distanceKm: Number.isFinite(raw.distanceKm) && raw.distanceKm >= 0 && raw.distanceKm <= 50000 ? raw.distanceKm : Number.isFinite(raw.distance_mi) && raw.distance_mi >= 0 && raw.distance_mi * 1.609344 <= 50000 ? Math.round(raw.distance_mi * 1.609344) : null,
    idTimestamp: raw.idTimestamp === null ? null : objectIdTimestamp(id, now), interests, descriptors, userPrompts, spotify: { themeTrack }, richPartial,
  };
  // Keep the portable profile under the library's 200 KB limit, reporting any loss.
  for (const key of ['userPrompts', 'descriptors', 'interests', 'photos']) {
    while (JSON.stringify(profile).length > 190000 && profile[key].length) { profile[key].pop(); profile.richPartial = true; }
  }
  return profile;
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
  return { chatId, accountId: selfId, accountProfile: selfId ? normalizeProfile(state.profile.user, now) : null, platform: 'tinder', route, profile, photos: profile.photos, messages,
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
  return { chatId, accountId: '', accountProfile: null, platform: 'whatsapp', route, profile, photos: profile.photos,
    messages: loaded.slice(-500).map(message => ({ id: identifier(message.id), role: message.isFromMe === true ? 'user' : message.isFromMe === false ? 'assistant' : 'unknown',
      text: text(message.body), createdAt: iso(typeof message.ts_sec === 'number' ? message.ts_sec * 1000 : message.createdAt),
      attachment: message.type && message.type !== 'chat' ? text(message.type) : null })),
    currentReliable: loaded.every(message => typeof message.isFromMe === 'boolean'),
    partial: true, source: 'loaded-app-state', omittedMessages: Math.max(0, (raw.loadedMessageCount ?? loaded.length) - 500), title: profile.name || 'Открытый диалог' };
}

export function sameConversation(left, right) {
  return Boolean(left && right && left.platform === right.platform && (left.accountId ?? '') === (right.accountId ?? '') && (left.accountScope ?? '') === (right.accountScope ?? '') && left.chatId === right.chatId);
}

export function portableConversation(context) {
  return { chatId: context.chatId, accountId: context.accountId ?? '', accountScope: context.accountScope ?? '', platform: context.platform, title: context.title,
    profile: normalizeProfile(context.profile), accountProfile: context.accountProfile ? normalizeProfile(context.accountProfile) : null,
    photos: (context.photos ?? []).slice(0, 20), partial: true,
    messages: (context.messages ?? []).map(({ id, role, text, createdAt }) => ({ id, role, text, createdAt: createdAt ?? null })) };
}

export function savedConversationFor(state, context) {
  if (!context?.accountId) return null;
  return (state?.conversations ?? []).find(record => !record.deleted && sameConversation(record, context)) ?? null;
}

export function captureChanged(saved, context) {
  if (!saved || !sameConversation(saved, context)) return false;
  const next = portableConversation(context);
  if (JSON.stringify(next.profile) !== JSON.stringify(normalizeProfile(saved.profile))
    || JSON.stringify(next.accountProfile) !== JSON.stringify(saved.accountProfile ? normalizeProfile(saved.accountProfile) : null)) return true;
  const byId = new Map((saved.messages ?? []).filter(message => message.id).map(message => [message.id, message]));
  return next.messages.some(message => !message.id || JSON.stringify(message) !== JSON.stringify(byId.get(message.id) && {
    id: byId.get(message.id).id, role: byId.get(message.id).role, text: byId.get(message.id).text, createdAt: byId.get(message.id).createdAt ?? null,
  }));
}

export function outgoingAcknowledged(context, attempt) {
  if (!sameConversation(context, attempt) || !context?.accountId || !context.currentReliable || context.source !== 'loaded-app-state') return false;
  return (context.messages ?? []).some(message => {
    if (!['user', 'outgoing'].includes(message.role) || message.text !== attempt.text) return false;
    const timestamp = message.createdAt ? Date.parse(message.createdAt) : NaN;
    if (Number.isFinite(timestamp) && timestamp < attempt.after) return false;
    return message.id ? !attempt.knownIds.includes(message.id) : Number.isFinite(timestamp) && timestamp >= attempt.after;
  });
}

export function normalizeLoadedBatch(raw, expectedAccountId) {
  if (!raw || raw.platform !== 'tinder' || !expectedAccountId || raw.accountId !== expectedAccountId || !Array.isArray(raw.conversations) || raw.conversations.length > 50) return null;
  const conversations = raw.conversations.map(value => {
    if (typeof value?.chatId !== 'string' || !value.chatId || !Array.isArray(value.messages) || value.messages.length > 500) return null;
    const route = `/app/messages/${encodeURIComponent(value.chatId)}`;
    const state = { routing: { pathname: route, params: { matchId: value.chatId } }, profile: { user: raw.accountProfile },
      entities: { matches: { [value.chatId]: { person: value.profile, messages: value.messages, loadedMessageCount: value.loadedMessageCount } } } };
    const result = conversationFromTinder(state, route);
    return result?.accountId === expectedAccountId ? { ...result, source: 'loaded-bulk-import', currentReliable: false } : null;
  });
  if (conversations.some(value => !value)) return null;
  return { conversations, nextCursor: Number.isInteger(raw.nextCursor) && raw.nextCursor >= 0 ? raw.nextCursor : null,
    partial: true, unknownDateCount: Number.isInteger(raw.unknownDateCount) ? raw.unknownDateCount : 0 };
}

export function normalizeSiteSnapshot(raw, loc) {
  const platform = platformFor(loc);
  if (!platform || raw?.platform !== platform || raw.route !== loc.pathname) return null;
  if (platform === 'tinder') {
    const conversation = conversationFromTinder(raw.state, loc.pathname);
    const cardId = raw.state?.recs?.recs?.queues?.main?.[0];
    const card = raw.state?.entities?.profiles?.[cardId];
    return { conversation, profile: card ? normalizeProfile(card) : null, accountId: identifier(raw.state?.profile?.user?._id),
      accountProfile: raw.state?.profile?.user?._id ? normalizeProfile(raw.state.profile.user) : null, source: 'loaded-app-state', route: loc.pathname };
  }
  return { conversation: conversationFromWhatsApp(raw.chat, loc.pathname), profile: null, source: 'loaded-app-state', route: loc.pathname };
}

export function incomingSnapshot(conversation) {
  const last = [...(conversation?.messages ?? [])].reverse().find(message => message.role === 'assistant' || message.role === 'unknown');
  return JSON.stringify([conversation?.platform ?? '', conversation?.accountId ?? '', conversation?.accountScope ?? '', conversation?.chatId ?? '',
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
