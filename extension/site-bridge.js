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
  let watchNumber = 1000000000;
  const nativeGeo = navigator.geolocation ? {
    get: navigator.geolocation.getCurrentPosition.bind(navigator.geolocation),
    watch: navigator.geolocation.watchPosition.bind(navigator.geolocation),
    clear: navigator.geolocation.clearWatch.bind(navigator.geolocation),
  } : null;
  const clean = value => JSON.parse(JSON.stringify(value));
  function send(payload) { window.postMessage({ channel, kind: 'snapshot', ...payload }, location.origin); }
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
      for (const module of Object.values(modules ?? {})) {
        const collection = module?.exports?.ChatCollection;
        if (typeof collection?.getActive === 'function') return collection;
      }
    } catch {}
    return null;
  }
  function tinderSnapshot() {
    const state = store.getState();
    const route = location.pathname;
    if (state.routing?.pathname && state.routing.pathname !== route) return;
    const matchId = state.routing?.params?.matchId;
    const match = matchId && state.entities?.matches?.[matchId];
    const profileId = typeof match?.person === 'string' ? match.person : match?.person?._id;
    const cardId = state.recs?.recs?.queues?.main?.[0];
    const profiles = {};
    for (const id of [profileId, cardId]) if (id && state.entities?.profiles?.[id]) profiles[id] = state.entities.profiles[id];
    const messages = {};
    for (const id of (match?.messages ?? []).slice(-500)) if (typeof id === 'string' && state.entities?.messages?.[id]) messages[id] = state.entities.messages[id];
    send({ platform, route, state: clean({ routing: { pathname: route, params: { matchId } },
      profile: { user: { _id: state.profile?.user?._id } },
      recs: { recs: { queues: { main: cardId ? [cardId] : [] } } },
      entities: { profiles, messages, matches: match ? { [matchId]: { person: match.person, messages: (match.messages ?? []).slice(-500), loadedMessageCount: (match.messages ?? []).length } } : {} } }) });
  }
  function whatsappSnapshot() {
    const chat = store.getActive();
    if (activeChat !== chat) {
      activeChat?.msgs?.off?.('change add remove', schedule);
      activeChat = chat;
      activeChat?.msgs?.on?.('change add remove', schedule);
    }
    if (!chat) { send({ platform, route: location.pathname, chat: null }); return; }
    const messages = (chat.msgs?.getModelsArray?.() ?? []).slice(-500).map(message => ({
      id: message.id?.toString?.() ?? '', body: message.body ?? message.caption ?? '', type: message.type,
      ts_sec: message.t, isFromMe: typeof message.id?.fromMe === 'boolean' ? message.id.fromMe : null,
    }));
    send({ platform, route: location.pathname, chat: {
      id: chat.id?.toString?.() ?? '', name: chat.contact?.name || chat.contact?.pushname || '',
      personId: chat.contact?.id?.toString?.() ?? '', personProfilePicUrl: chat.contact?.profilePicThumb?.imgFull ?? '', messages, loadedMessageCount: chat.msgs?.getModelsArray?.().length ?? messages.length,
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
    } catch { store = null; send({ platform, route: location.pathname, unavailable: true }); }
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
        const value = position();
        queueMicrotask(() => { if (watchers.has(id)) success(value); });
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
    if (event.data.kind === 'request') schedule();
    if (event.data.kind === 'geo') {
      geo = validGeo(event.data.value) ? { ...event.data.value } : null;
      for (const record of watchers.values()) {
        if (geo) {
          if (record.nativeId !== null) { nativeGeo.clear(record.nativeId); record.nativeId = null; }
          const value = position();
          queueMicrotask(() => record.success(value));
        } else if (record.nativeId === null) record.nativeId = nativeGeo.watch(record.success, record.error, record.options);
      }
    }
  });
  window.addEventListener('pagehide', () => {
    if (typeof subscribed === 'function') subscribed();
    if (platform === 'whatsapp') store?.off?.('change:active', schedule);
    activeChat?.msgs?.off?.('change add remove', schedule);
    cancelAnimationFrame(frame);
    watchers = new Map();
  }, { once: true });
  window.navigation?.addEventListener('currententrychange', schedule);
  window.addEventListener('popstate', schedule);
  const observer = new MutationObserver(schedule);
  observer.observe(document, { subtree: true, childList: true });
  schedule();
})();
