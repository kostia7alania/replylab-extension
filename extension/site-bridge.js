(() => {
  if (window.__replylabSiteBridge) return;
  window.__replylabSiteBridge = true;
  const channel = 'replylab:site';
  const platform = location.hostname === 'web.whatsapp.com' ? 'whatsapp' : location.hostname === 'tinder.com' || location.hostname.endsWith('.tinder.com') ? 'tinder' : null;
  if (!platform) return;
  let store = null;
  let subscribed = null;
  let activeChat = null;
  let frame = 0;
  let geo = null;
  let geoRequestCount = 0;
  let watchers = new Map();
  let watchNumber = 1000000000, lastSnapshot = '';
  const nativeGeo = navigator.geolocation ? {
    get: navigator.geolocation.getCurrentPosition.bind(navigator.geolocation),
    watch: navigator.geolocation.watchPosition.bind(navigator.geolocation),
    clear: navigator.geolocation.clearWatch.bind(navigator.geolocation),
  } : null;
  const bounded = (value, max = 1000) => typeof value === 'string' || typeof value === 'number' ? String(value).slice(0, max) : '';
  function pickProfile(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const track = raw.spotify?.spotify_theme_track;
    const profile = { _id: bounded(raw._id ?? raw.id, 150), name: bounded(raw.name, 150), bio: bounded(raw.bio, 10000),
      birth_date: typeof raw.birth_date === 'string' ? bounded(raw.birth_date, 40) : null,
      age: Number.isFinite(raw.age) ? raw.age : null, city: bounded(typeof raw.city === 'object' ? raw.city?.name : raw.city, 150),
      distance_mi: Number.isFinite(raw.distance_mi) ? raw.distance_mi : null,
      photos: (Array.isArray(raw.photos) ? raw.photos : []).slice(0, 20).filter(photo => !photo?.is_video && photo?.type !== 'video')
        .map(photo => typeof photo === 'string' ? bounded(photo, 3000) : bounded(photo?.processedFiles?.[0]?.url || photo?.url, 3000)).filter(Boolean),
      interests: (raw.user_interests?.selected_interests ?? []).slice(0, 100).map(value => bounded(value?.name, 200)),
      descriptors: (raw.selected_descriptors ?? []).slice(0, 100).map(value => ({ id: bounded(value?.id, 150), name: bounded(value?.name, 200), type: typeof value?.type === 'string' ? bounded(value.type, 100) : null,
        value: bounded(value?.measurable_selection ? [value.measurable_selection.value, value.measurable_selection.unit_of_measure].filter(value => value !== undefined && value !== null && value !== '').join(' ')
          : (value?.choice_selections ?? []).map(choice => bounded(choice?.name, 200)).join(', '), 1000) })),
      userPrompts: (raw.user_prompts?.prompts ?? []).slice(0, 50).map(value => ({ id: bounded(value?.id, 150), question: bounded(value?.question_text, 1000), answer: bounded(value?.answer_text, 10000) })),
      spotify: { themeTrack: track ? { name: bounded(track.name, 300), artists: (track.artists ?? []).slice(0, 30).map(artist => bounded(artist?.name, 200)) } : null }, richPartial: true };
    for (const key of ['userPrompts', 'descriptors', 'interests', 'photos']) while (JSON.stringify(profile).length > 190000 && profile[key].length) profile[key].pop();
    return profile;
  }
  function pickMessages(state, match) {
    const loaded = Array.isArray(match?.messages) ? match.messages : [];
    const records = []; let size = 0;
    for (const reference of loaded.slice(-500).reverse()) {
      const raw = typeof reference === 'object' ? reference : state.entities?.messages?.[reference];
      if (!raw || typeof raw !== 'object') continue;
      const record = { _id: bounded(raw._id ?? raw.id ?? reference, 500), from: bounded(raw.from ?? raw.fromId, 500), to: bounded(raw.to ?? raw.toId, 500),
        message: bounded(raw.message ?? raw.text ?? raw.body, 50000), type: bounded(raw.type, 100),
        sent_date: typeof (raw.sent_date ?? raw.timestamp ?? raw.createdAt) === 'string' || typeof (raw.sent_date ?? raw.timestamp ?? raw.createdAt) === 'number' ? raw.sent_date ?? raw.timestamp ?? raw.createdAt : null };
      size += JSON.stringify(record).length;
      if (size > 500000) break;
      records.push(record);
    }
    return { records: records.reverse(), loadedMessageCount: loaded.length };
  }
  function send(payload) {
    const fingerprint = JSON.stringify(payload);
    if (fingerprint === lastSnapshot) return;
    lastSnapshot = fingerprint; window.postMessage({ channel, kind: 'snapshot', ...payload }, location.origin);
  }
  function discoverTinder() {
    const queue = [];
    for (const element of [...(document.body?.children ?? [])].slice(0, 30)) {
      for (const key of Object.keys(element).filter(key => key.startsWith('__'))) queue.push([element[key], 0]);
    }
    const seen = new WeakSet();
    for (let index = 0; index < queue.length && index < 1200; index++) {
      const [value, depth] = queue[index];
      if (!value || typeof value !== 'object' || seen.has(value) || value instanceof Node) continue;
      seen.add(value);
      try {
        if (typeof value.getState === 'function' && typeof value.subscribe === 'function') {
          const state = value.getState();
          if (state?.routing && state?.entities) return value;
        }
        if (depth >= 7) continue;
        for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) {
          if (queue.length >= 2000) break;
          if ('value' in descriptor && descriptor.value && typeof descriptor.value === 'object') queue.push([descriptor.value, depth + 1]);
        }
      } catch {}
    }
    return null;
  }
  function discoverWhatsApp() {
    try {
      const modules = window.require?.('__debug')?.modulesMap;
      for (const module of Object.values(modules ?? {}).slice(0, 10000)) {
        const collection = module?.exports?.ChatCollection;
        if (typeof collection?.getActive === 'function') return collection;
      }
    } catch {}
    return null;
  }
  function tinderSnapshot() {
    const state = store.getState(), route = location.pathname;
    if (state.routing?.pathname && state.routing.pathname !== route) return;
    const matchId = bounded(state.routing?.params?.matchId, 500);
    const match = matchId && state.entities?.matches?.[matchId];
    const profileId = typeof match?.person === 'string' ? match.person : match?.person?._id;
    const cardId = state.recs?.recs?.queues?.main?.[0];
    const profiles = {};
    for (const id of [profileId, cardId]) if (typeof id === 'string' && state.entities?.profiles?.[id]) profiles[id] = pickProfile(state.entities.profiles[id]);
    const selected = pickMessages(state, match);
    send({ platform, route, state: { routing: { pathname: route, params: { matchId } }, profile: { user: pickProfile(state.profile?.user) },
      recs: { recs: { queues: { main: typeof cardId === 'string' ? [cardId] : [] } } },
      entities: { profiles, matches: match ? { [matchId]: { person: typeof match.person === 'object' ? pickProfile(match.person) : bounded(match.person, 500),
        messages: selected.records, loadedMessageCount: selected.loadedMessageCount } } : {} } } });
  }
  function importLoaded(request) {
    const requestId = bounded(request.requestId, 100);
    if (platform !== 'tinder' || !requestId) return;
    const respond = result => window.postMessage({ channel, kind: 'import-result', requestId, route: location.pathname, ...result }, location.origin);
    try {
      const state = (store ?? discoverTinder())?.getState(), accountProfile = pickProfile(state?.profile?.user), accountId = accountProfile?._id;
      if (!accountId || request.accountId !== accountId) throw new Error('Не удалось подтвердить текущий аккаунт.');
      const cursor = Number.isInteger(request.cursor) && request.cursor >= 0 ? request.cursor : 0;
      const from = request.from == null ? -Infinity : request.from, to = request.to == null ? Infinity : request.to;
      if ((from !== -Infinity && !Number.isFinite(from)) || (to !== Infinity && !Number.isFinite(to)) || from > to) throw new Error('Некорректный диапазон дат.');
      const keys = Object.keys(state.entities?.matches ?? {}).slice(0, 10000).sort();
      const conversations = []; let next = cursor, bytes = JSON.stringify(accountProfile).length, unknownDateCount = 0;
      while (next < keys.length && conversations.length < 50) {
        const chatId = keys[next], match = state.entities.matches[chatId];
        const selected = pickMessages(state, match);
        const profile = pickProfile(typeof match?.person === 'object' ? match.person : state.entities.profiles?.[match?.person]);
        let excludedUnknown = 0;
        const messages = selected.records.filter(message => {
          if (from === -Infinity && to === Infinity) return true;
          const timestamp = message.sent_date == null ? NaN : new Date(message.sent_date).getTime();
          if (!Number.isFinite(timestamp)) { excludedUnknown++; return false; }
          return timestamp >= from && timestamp <= to;
        });
        const conversation = { chatId, profile, messages, loadedMessageCount: selected.loadedMessageCount };
        const size = JSON.stringify(conversation).length;
        if (conversations.length && bytes + size > 750000) break;
        // A single bounded conversation fits even when the next batch must start immediately afterwards.
        conversations.push(conversation); bytes += size; unknownDateCount += excludedUnknown; next++;
      }
      respond({ ok: true, platform, accountId, accountProfile, conversations, nextCursor: next < keys.length ? next : null, unknownDateCount, partial: true });
    } catch (error) { respond({ ok: false, error: error.message || 'Не удалось прочитать загруженные диалоги.' }); }
  }
  function whatsappSnapshot() {
    const chat = store.getActive();
    if (activeChat !== chat) {
      activeChat?.msgs?.off?.('change add remove', schedule);
      activeChat = chat;
      activeChat?.msgs?.on?.('change add remove', schedule);
    }
    if (!chat) { send({ platform, route: location.pathname, chat: null }); return; }
    const loaded = chat.msgs?.getModelsArray?.() ?? [], messages = [];
    let bytes = 0;
    for (const message of loaded.slice(-500).reverse()) {
      const record = { id: bounded(message.id?.toString?.(), 500), body: bounded(message.body ?? message.caption, 10000), type: bounded(message.type, 100),
        ts_sec: Number.isFinite(message.t) ? message.t : null, isFromMe: typeof message.id?.fromMe === 'boolean' ? message.id.fromMe : null };
      bytes += JSON.stringify(record).length; if (bytes > 500000) break; messages.push(record);
    }
    messages.reverse();
    send({ platform, route: location.pathname, chat: {
      id: bounded(chat.id?.toString?.(), 500), name: bounded(chat.contact?.name || chat.contact?.pushname, 150),
      personId: bounded(chat.contact?.id?.toString?.(), 500), personProfilePicUrl: bounded(chat.contact?.profilePicThumb?.imgFull, 3000), messages, loadedMessageCount: loaded.length,
    } });
  }
  function snapshot() {
    frame = 0;
    try {
      if (!store) {
        store = platform === 'tinder' ? discoverTinder() : discoverWhatsApp();
        if (store) {
          if (platform === 'tinder') subscribed = store.subscribe(schedule);
          else store.on?.('change:active', schedule);
        }
      }
      if (!store) { send({ platform, route: location.pathname, unavailable: true }); return; }
      if (platform === 'tinder') tinderSnapshot(); else whatsappSnapshot();
    } catch { disconnectStore(); send({ platform, route: location.pathname, unavailable: true }); }
  }
  function disconnectStore() {
    if (typeof subscribed === 'function') subscribed();
    if (platform === 'whatsapp') store?.off?.('change:active', schedule);
    activeChat?.msgs?.off?.('change add remove', schedule); subscribed = null; activeChat = null; store = null;
  }
  function schedule() { if (!frame) frame = requestAnimationFrame(snapshot); }
  const validGeo = value => value?.enabled === true && Number.isFinite(value.latitude) && Math.abs(value.latitude) <= 90
    && Number.isFinite(value.longitude) && Math.abs(value.longitude) <= 180
    && Number.isFinite(value.accuracy ?? 100) && (value.accuracy ?? 100) > 0 && (value.accuracy ?? 100) <= 100000;
  const position = () => ({ coords: { latitude: geo.latitude, longitude: geo.longitude, accuracy: geo.accuracy ?? 100,
    altitude: null, altitudeAccuracy: null, heading: null, speed: null }, timestamp: Date.now() });
  if (nativeGeo) {
    const recordGeoRequest = operation => {
      if (geoRequestCount++ < 100) window.postMessage({ channel, kind: 'geo-request', operation, overridden: Boolean(geo) }, location.origin);
    };
    navigator.geolocation.getCurrentPosition = (success, error, options) => {
      recordGeoRequest('getCurrentPosition');
      if (!geo) return nativeGeo.get(success, error, options);
      const value = position();
      queueMicrotask(() => success(value));
    };
    navigator.geolocation.watchPosition = (success, error, options) => {
      recordGeoRequest('watchPosition');
      const id = ++watchNumber;
      const record = { success, error, options, nativeId: null };
      watchers.set(id, record);
      if (!geo) record.nativeId = nativeGeo.watch(success, error, options);
      else {
        const value = position(), expected = geo;
        queueMicrotask(() => { if (watchers.get(id) === record && geo === expected) success(value); });
      }
      return id;
    };
    navigator.geolocation.clearWatch = id => {
      const record = watchers.get(id);
      if (!record) { nativeGeo.clear(id); return; }
      if (record.nativeId !== null) nativeGeo.clear(record.nativeId);
      watchers.delete(id);
    };
  }
  window.addEventListener('message', event => {
    if (event.source !== window || event.origin !== location.origin || event.data?.channel !== channel) return;
    if (event.data.kind === 'request') { lastSnapshot = ''; schedule(); }
    if (event.data.kind === 'import-loaded') importLoaded(event.data);
    if (event.data.kind === 'geo') {
      const nextGeo = validGeo(event.data.value) ? { enabled: true, latitude: event.data.value.latitude, longitude: event.data.value.longitude, accuracy: event.data.value.accuracy ?? 100 } : null;
      if (JSON.stringify(geo) === JSON.stringify(nextGeo)) return;
      geo = nextGeo;
      for (const [id, record] of watchers) {
        if (geo) {
          if (record.nativeId !== null) { nativeGeo.clear(record.nativeId); record.nativeId = null; }
          const value = position();
          const expected = geo;
          queueMicrotask(() => { if (watchers.get(id) === record && geo === expected) record.success(value); });
        } else if (record.nativeId === null) record.nativeId = nativeGeo.watch(record.success, record.error, record.options);
      }
    }
  });
  window.addEventListener('pagehide', event => {
    if (event.persisted) return;
    disconnectStore(); observer.disconnect(); cancelAnimationFrame(frame);
    for (const record of watchers.values()) if (record.nativeId !== null) nativeGeo.clear(record.nativeId);
    watchers.clear();
  });
  window.addEventListener('pageshow', schedule);
  window.navigation?.addEventListener('currententrychange', schedule);
  window.addEventListener('popstate', schedule);
  const observer = new MutationObserver(schedule);
  observer.observe(document, { subtree: true, childList: true });
  schedule();
})();
