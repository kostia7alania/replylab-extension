import { findComposer, insertReply, draftText, findSendButton, findProfileAnchor } from './page-adapter.js';
import { platformFor, normalizeSiteSnapshot, renderedContext, incomingSnapshot, transcript, validGeo, canAutoSendContext, isStyleEligible, instagramLinks, languageHint } from './site-context.js';
import { translate as uiTranslate, SOURCE_MESSAGES, SUPPORTED_LANGUAGES } from './locales.js';

let stopCurrent = null;
const channel = 'replylab:site';
const UI_SOURCES = new Map(SOURCE_MESSAGES.map(({ ru, en }) => [ru, en]));
const active = values => (values ?? []).filter(value => !value.deleted);
const button = (text, className = '') => Object.assign(document.createElement('button'), { type: 'button', textContent: text, className });
const trusted = (element, callback) => element.addEventListener('click', event => {
  if (event.isTrusted) Promise.resolve().then(() => callback(event)).catch(error => {
    const status = element.getRootNode()?.querySelector?.('.status');
    if (status) { status.textContent = error.message || 'Действие не выполнено.'; status.classList.add('error'); }
  });
});

function portableConversation(context) {
  return { chatId: context.chatId, accountId: context.accountId ?? '', platform: context.platform, title: context.title,
    profile: { id: context.profile?.id ?? '', name: context.profile?.name ?? '', bio: context.profile?.bio ?? '', photos: (context.photos ?? []).slice(0, 20) },
    photos: (context.photos ?? []).slice(0, 20), partial: true,
    messages: (context.messages ?? []).map(({ id, role, text, createdAt }) => ({ id, role, text, createdAt: createdAt ?? null })) };
}

function createPanel(composer, anchor, env) {
  const initial = env.context();
  const key = initial?.chatId ?? '';
  const route = location.href;
  const host = document.createElement('aside');
  host.dataset.replylabHelper = '';
  host.setAttribute('aria-label', 'Помощник ReplyLab');
  const shadow = host.attachShadow({ mode: 'open', delegatesFocus: true });
  shadow.append(Object.assign(document.createElement('link'), { rel: 'stylesheet', href: chrome.runtime.getURL('panel.css') }));
  const panel = document.createElement('section');
  panel.className = 'panel';
  panel.innerHTML = `
    <header><div><strong>ReplyLab</strong><span class="subtitle">Контекст открытого диалога</span></div><button type="button" class="settings">Настроить ReplyLab</button></header>
    <div class="profile-summary"></div><p class="coverage"></p>
    <details class="profile-details"><summary>Профиль и фотографии</summary><p class="bio"></p><p class="language-hint"></p><p class="encountered"></p><p class="xray"></p><div class="bio-actions"><button type="button" class="copy-bio secondary">Копировать описание</button><button type="button" class="translate-bio secondary">Перевести описание</button></div><p class="bio-translation"></p><div class="instagram-links"></div><div class="photos"></div><label class="check"><input class="include-photos" type="checkbox">Прикрепить фотографии к запросу GPT</label></details>
    <label class="context-label">Дополнительный контекст<textarea class="context" rows="2" placeholder="Можно дополнить прочитанную часть диалога"></textarea></label>
    <div class="controls"><label>Тон<select class="tone"><option value="friendly">Дружелюбный</option><option value="playful">Игривый</option><option value="concise">Краткий</option></select></label><label>Стиль<select class="style"><option value="">Общий</option></select></label><label>Ответов<select class="count"><option>1</option><option>2</option><option selected>3</option></select></label></div>
    <button type="button" class="generate">Предложить ответы</button><button type="button" class="cancel-generation secondary" hidden>Остановить генерацию</button><p class="status" role="status" aria-live="polite">Выберите действие. Отправку контролируете вы.</p><p class="live-result"></p>
    <div class="results"></div><div class="confirmation" hidden></div>
    <div class="tools"><button type="button" class="capture secondary">Сохранить диалог</button><button type="button" class="copy-transcript secondary">Копировать историю</button><button type="button" class="export secondary">Экспорт .txt</button><button type="button" class="assistant secondary">Чат-ассистент</button></div>
    <details class="external-section"><summary>Открыть во внешнем помощнике</summary><p class="external-note">Текст не передаётся автоматически. Сначала подтвердите копирование.</p><div class="external-tools"></div><div class="external-confirmation" hidden></div></details>
    <details class="note-section"><summary>Заметка к диалогу</summary><textarea class="note" rows="2" placeholder="Ваша локальная заметка"></textarea><button type="button" class="save-note secondary">Сохранить заметку</button></details>
    <details class="translation-section"><summary>Перевод</summary><div class="controls"><label>Язык<input class="language" value="ru" maxlength="40"></label><button type="button" class="translate secondary">Перевести историю</button></div><p class="translation"></p></details>
    <details class="schedule-section"><summary>Запланировать черновик</summary><textarea class="scheduled-text" rows="2" placeholder="Текст сообщения"></textarea><input class="fire-at" type="datetime-local"><label class="check"><input class="automatic" type="checkbox">Автоматически, только при отдельном разрешении в настройках</label><button type="button" class="schedule secondary">Добавить в очередь</button><div class="queue"></div></details>
    <details><summary>Вид и геопозиция</summary><label class="check"><input class="blur" type="checkbox">Скрывать фотографии</label><div class="controls"><label>Широта<input class="latitude" type="number" min="-90" max="90" step="any"></label><label>Долгота<input class="longitude" type="number" min="-180" max="180" step="any"></label></div><label class="check"><input class="geo-enabled" type="checkbox">Подставлять эту геопозицию на сайте</label><button type="button" class="save-geo secondary">Применить</button></details>
    <p class="footnote">Вставка не отправляет сообщение. История ограничена загруженными на сайте сообщениями.</p>`;
  shadow.append(panel);
  const $ = selector => shadow.querySelector(selector);
  const status = $('.status');
  const textSources = new WeakMap(), attributeSources = new WeakMap();
  let disposed = false, requestNumber = 0, pending = null, cancelGeneration = null, lastIncoming = incomingSnapshot(initial), lastLibrary = null, lastProfile = '', lastLanguage = '', lastStyleSignature = '', savedCountSetting = null, manualCount = false;
  const uiLanguage = () => SUPPORTED_LANGUAGES.includes(env.state()?.settings?.language) ? env.state().settings.language : env.state()?.settings?.language ? 'en' : 'ru';
  const label = (ru, en = UI_SOURCES.get(ru)) => en ? uiTranslate(ru, en, uiLanguage()) : ru;
  const format = (ru, en, values) => label(ru, en).replace(/\{\{(\w+)\}\}/g, (_, name) => String(values[name] ?? ''));
  function localizeUI() {
    host.lang = uiLanguage();
    for (const element of shadow.querySelectorAll('button, summary, label, option, .subtitle, .footnote, .status, .external-note, .confirmation > p, .external-confirmation > p')) {
      if (element.matches('option') && element.parentElement?.matches('.style') && element.value) continue;
      for (const node of element.childNodes) {
        if (node.nodeType !== Node.TEXT_NODE || !node.nodeValue.trim()) continue;
        const source = textSources.get(node) ?? node.nodeValue.trim();
        if (!UI_SOURCES.has(source)) continue;
        textSources.set(node, source);
        node.nodeValue = node.nodeValue.replace(node.nodeValue.trim(), label(source));
      }
    }
    for (const element of [host, ...shadow.querySelectorAll('[placeholder], [aria-label], [title], [alt]')]) {
      const remembered = attributeSources.get(element) ?? new Map();
      for (const name of ['placeholder', 'aria-label', 'title', 'alt']) {
        const source = remembered.get(name) ?? element.getAttribute(name);
        if (!UI_SOURCES.has(source)) continue;
        remembered.set(name, source); element.setAttribute(name, label(source));
      }
      attributeSources.set(element, remembered);
    }
  }
  const notify = (text, error = false) => { status.textContent = text; status.classList.toggle('error', error); localizeUI(); };
  const current = () => !disposed && host.isConnected && route === location.href && (env.context()?.chatId ?? '') === key
    && (composer ? composer === findComposer(document, location) : anchor === findProfileAnchor(document, location));
  const run = async (action, payload) => {
    if (!current()) { env.schedule(); throw new Error('Открытый диалог изменился.'); }
    return env.action(action, payload);
  };
  const event = kind => run('record-event', { event: { kind, platform: env.context()?.platform, chatId: key, at: new Date().toISOString() } }).catch(() => {});
  function clearPending() { pending = null; $('.confirmation').hidden = true; $('.confirmation').replaceChildren(); }
  function insert(text) {
    if (!current() || !composer) { notify('Откройте диалог с полем сообщения.', true); env.schedule(); return; }
    clearPending();
    if (!insertReply(composer, text)) { notify('Поле сообщения изменилось.', true); env.schedule(); return; }
    notify('Вариант вставлен. Проверьте и отправьте его сами.'); event('reply-inserted');
  }
  function requestInsertion(text) {
    if (!current() || !composer) { notify('Откройте диалог с полем сообщения.', true); return; }
    clearPending();
    if (draftText(composer) === text) { notify('Этот вариант уже в поле сообщения.'); return; }
    if (!draftText(composer).length) { insert(text); return; }
    pending = { text, draft: draftText(composer) };
    const explanation = Object.assign(document.createElement('p'), { textContent: 'В поле уже есть черновик. Заменить его этим вариантом?' });
    const accept = button('Заменить черновик', 'confirm'), cancel = button('Оставить черновик', 'secondary');
    trusted(accept, () => {
      if (!current()) { env.schedule(); return; }
      if (!pending || draftText(composer) !== pending.draft) { clearPending(); notify('Черновик изменился. Снова нажмите «Вставить».', true); return; }
      insert(pending.text);
    });
    trusted(cancel, clearPending);
    $('.confirmation').append(explanation, accept, cancel); $('.confirmation').hidden = false;
    notify('Черновик сохранён. Замена требует подтверждения.');
  }
  async function copy(value) { await navigator.clipboard.writeText(value); if (current()) notify('Скопировано.'); }
  async function translate(value, destination) {
    if (!value || value.length > 10000) throw new Error('Для перевода нужен текст до 10 000 символов.');
    const response = await chrome.runtime.sendMessage({ type: 'replylab:action', action: 'translate', payload: { text: value, targetLanguage: $('.language').value.trim() || 'ru', context: env.context() } });
    if (!current()) return;
    if (!response?.ok || typeof response.text !== 'string') throw new Error(response?.error || 'Перевод не получен.');
    destination.textContent = response.text;
  }
  function streamReplies(payload, number) {
    if (typeof chrome.runtime.connect !== 'function') return chrome.runtime.sendMessage({ type: 'replylab:suggest', ...payload });
    return new Promise((resolve, reject) => {
      const id = crypto.randomUUID(), port = chrome.runtime.connect({ name: 'replylab:stream' });
      let finished = false;
      function finish(error, result) {
        if (finished) return;
        finished = true;
        port.onMessage.removeListener(receive); port.onDisconnect.removeListener(disconnected);
        cancelGeneration = null; port.disconnect();
        if (error) reject(error); else resolve(result);
      }
      function receive(message) {
        if (message.id !== id) return;
        if (message.type === 'delta' && current() && number === requestNumber) $('.live-result').textContent += message.text || '';
        if (message.type === 'result') finish(null, message.result);
        if (message.type === 'error') finish(new Error(message.error || 'Поток ответа прерван.'));
      }
      function disconnected() { finish(new Error('Соединение с расширением прервано.')); }
      cancelGeneration = () => {
        try { port.postMessage({ type: 'cancel', id }); } catch {}
        finish(new DOMException('Генерация отменена.', 'AbortError'));
      };
      port.onMessage.addListener(receive); port.onDisconnect.addListener(disconnected);
      port.postMessage({ id, task: 'replies', payload });
    });
  }
  trusted($('.cancel-generation'), () => { cancelGeneration?.(); notify('Генерация отменена.'); });
  function render(replies) {
    $('.results').replaceChildren(...replies.map(reply => {
      const article = Object.assign(document.createElement('article'), { className: 'reply' });
      const text = Object.assign(document.createElement('p'), { textContent: reply.text });
      const reason = Object.assign(document.createElement('small'), { textContent: reply.reason });
      const actions = Object.assign(document.createElement('div'), { className: 'actions' });
      const add = button('Вставить', 'insert'); add.disabled = !composer;
      trusted(add, () => requestInsertion(reply.text));
      const copyButton = button('Копировать', 'secondary');
      trusted(copyButton, () => copy(reply.text).catch(() => notify('Скопируйте выделенный текст вручную.', true)));
      const translateButton = button('Перевести', 'secondary');
      const translated = Object.assign(document.createElement('div'), { className: 'translated' });
      trusted(translateButton, () => translate(reply.text, translated).catch(error => notify(error.message, true)));
      const scheduleButton = button('Позже', 'secondary'); scheduleButton.disabled = !composer;
      trusted(scheduleButton, () => { $('.scheduled-text').value = reply.text; $('.schedule-section').open = true; $('.fire-at').focus(); });
      actions.append(add, copyButton, translateButton, scheduleButton); article.append(text, reason, actions, translated); return article;
    }));
  }
  trusted($('.generate'), async () => {
    if (!current()) { env.schedule(); return; }
    const context = env.context(), selection = window.getSelection();
    const selected = selection?.anchorNode?.getRootNode() === document && selection?.focusNode?.getRootNode() === document ? selection.toString().trim() : '';
    const text = $('.context').value.trim() || draftText(composer).trim() || selected || (context.messages?.length ? 'Предложи ответ на последнее сообщение открытого диалога.' : context.profile?.bio ? 'Предложи первое сообщение по профилю.' : '');
    if (!text) { notify('Добавьте контекст: сообщения или профиль пока не прочитаны.', true); $('.context').focus(); return; }
    if (text.length > 10000) { notify('Контекст длиннее 10 000 символов. Сократите его вручную.', true); return; }
    const number = ++requestNumber, before = incomingSnapshot(context);
    clearPending(); $('.results').replaceChildren(); $('.live-result').textContent = ''; $('.generate').disabled = true; $('.cancel-generation').hidden = false; notify('Готовим варианты…');
    try {
      const response = await streamReplies({ text, tone: $('.tone').value, context,
        styleId: $('.style').value || undefined, count: Number($('.count').value), includePhotos: !$('.profile-details').hidden && $('.include-photos').checked }, number);
      if (!current() || number !== requestNumber || before !== incomingSnapshot(env.context())) return;
      if (!response?.ok) throw new Error(response?.error || 'Не удалось получить варианты.');
      if (!Array.isArray(response.replies) || response.replies.length < 1 || response.replies.length > 3
        || response.replies.some(reply => typeof reply?.text !== 'string' || !reply.text.trim() || typeof reply.reason !== 'string')) throw new Error('Получен некорректный ответ.');
      render(response.replies); notify('Выберите вариант. Замена черновика требует подтверждения.'); event('reply-generated');
    } catch (error) { if (current() && number === requestNumber) notify(error.message, true); }
    finally { if (!disposed && number === requestNumber) { $('.generate').disabled = false; $('.cancel-generation').hidden = true; } }
  });
  trusted($('.settings'), () => chrome.runtime.sendMessage({ type: 'replylab:open-options' }).catch(() => notify('Откройте ReplyLab с панели расширений.', true)));
  trusted($('.assistant'), () => chrome.runtime.sendMessage({ type: 'replylab:open-options', view: 'assistant', context: portableConversation(env.context()) }));
  trusted($('.capture'), async () => { await run('capture', { conversation: portableConversation(env.context()) }); notify('Загруженная часть диалога сохранена.'); });
  trusted($('.copy-transcript'), () => copy(transcript(env.context())).catch(() => notify('Не удалось скопировать историю.', true)));
  trusted($('.copy-bio'), () => copy(env.context().profile?.bio || '').catch(() => notify('Не удалось скопировать описание.', true)));
  trusted($('.translate-bio'), () => translate(env.context().profile?.bio, $('.bio-translation')).catch(error => notify(error.message, true)));
  const externalSites = [['ChatGPT', 'https://chatgpt.com/'], ['Claude', 'https://claude.ai/'], ['Grok', 'https://grok.com/'], ['T3', 'https://t3.chat/'], ['Perplexity', 'https://www.perplexity.ai/'], ['Google Translate', 'https://translate.google.com/']];
  for (const [name, url] of externalSites) {
    const open = button(`${name} ↗`, 'secondary');
    trusted(open, () => {
      if (!current()) return;
      const confirmation = $('.external-confirmation');
      const warning = Object.assign(document.createElement('p'), { textContent: 'История будет скопирована в буфер. Откроется выбранный сайт; текст попадёт туда только после вашей вставки.' });
      const accept = button('Скопировать и открыть', 'secondary'), cancel = button('Отменить', 'secondary');
      trusted(accept, async () => {
        if (!current()) return;
        const value = transcript(env.context());
        if (value.length > 100000) throw new Error('История слишком большая для этого действия. Используйте экспорт.');
        window.open(url, '_blank', 'noopener,noreferrer');
        await copy(value); confirmation.hidden = true;
      });
      trusted(cancel, () => { confirmation.hidden = true; confirmation.replaceChildren(); });
      confirmation.replaceChildren(warning, accept, cancel); confirmation.hidden = false; localizeUI();
    });
    $('.external-tools').append(open);
  }
  trusted($('.export'), () => {
    const context = env.context(), url = URL.createObjectURL(new Blob([transcript(context)], { type: 'text/plain;charset=utf-8' }));
    Object.assign(document.createElement('a'), { href: url, download: `replylab-${context.platform}-${context.chatId.replace(/[^a-zA-Z0-9_-]/g, '_')}.txt` }).click();
    setTimeout(() => URL.revokeObjectURL(url), 1000); notify('История выгружена в .txt.');
  });
  trusted($('.save-note'), async () => { await run('save-note', { chatId: key, text: $('.note').value }); notify('Заметка сохранена.'); });
  trusted($('.translate'), () => translate(transcript(env.context()), $('.translation')).catch(error => notify(error.message, true)));
  $('.blur').addEventListener('change', event => { if (event.isTrusted) run('save-settings', { settings: { blurImages: event.target.checked } }).catch(error => notify(error.message, true)); });
  trusted($('.save-geo'), async () => {
    const geo = { enabled: $('.geo-enabled').checked, latitude: Number($('.latitude').value), longitude: Number($('.longitude').value), accuracy: 100 };
    if (geo.enabled && (!$('.latitude').value || !$('.longitude').value || !validGeo(geo))) { notify('Введите широту −90…90 и долготу −180…180.', true); return; }
    await run('save-settings', { settings: { geo } }); event(geo.enabled ? 'geo-override-enabled' : 'geo-override-disabled'); notify(geo.enabled ? 'Геопозиция применяется на этой вкладке.' : 'Подстановка геопозиции выключена.');
  });
  trusted($('.schedule'), async () => {
    const text = $('.scheduled-text').value, timestamp = new Date($('.fire-at').value).getTime();
    if (!composer || !text.trim() || text.length > 10000 || !Number.isFinite(timestamp) || timestamp <= Date.now()) { notify('Нужны текст и время в будущем.', true); return; }
    if ($('.automatic').checked && !env.state()?.settings?.autoSendEnabled) { notify('Сначала отдельно разрешите автоматическую отправку в настройках.', true); return; }
    await run('schedule', { item: { chatId: key, platform: env.context().platform, text, fireAt: new Date(timestamp).toISOString(), status: 'scheduled',
      sendMode: $('.automatic').checked ? 'automatic' : 'review', incomingSnapshot: incomingSnapshot(env.context()) } });
    notify('Запись добавлена в очередь. По умолчанию потребуется ваше действие.');
  });
  function renderQueue() {
    const items = active(env.state()?.schedules).filter(item => item.chatId === key && item.platform === env.context()?.platform && ['scheduled', 'ready', 'firing'].includes(item.status));
    $('.queue').replaceChildren(...items.map(item => {
      const row = Object.assign(document.createElement('article'), { className: 'queue-item' });
      const description = Object.assign(document.createElement('p'), { textContent: `${new Date(item.fireAt).toLocaleString(uiLanguage())} · ${item.sendMode === 'automatic' ? label('автоматически') : label('проверка')} · ${item.text}` });
      const add = button('Подготовить черновик', 'secondary'); trusted(add, () => requestInsertion(item.text));
      const cancel = button('Отменить', 'secondary'); trusted(cancel, () => run('cancel-schedule', { id: item.id }));
      row.append(description, add, cancel); return row;
    }));
  }
  $('.style').addEventListener('change', () => {
    const style = active(env.state()?.styles).find(style => style.id === $('.style').value && isStyleEligible(style, env.context()));
    if (style) { $('.count').value = String(style.suggestionCount ?? 3); manualCount = false; }
  });
  $('.count').addEventListener('change', () => { manualCount = true; });
  function update() {
    if (!current()) return;
    const context = env.context(), incoming = incomingSnapshot(context), languageChanged = uiLanguage() !== lastLanguage;
    lastLanguage = uiLanguage();
    if (incoming !== lastIncoming) {
      lastIncoming = incoming; requestNumber++; cancelGeneration?.(); clearPending(); $('.results').replaceChildren(); $('.live-result').textContent = ''; $('.generate').disabled = false; $('.cancel-generation').hidden = true;
      notify('Появились новые сообщения. Предложите ответы ещё раз.');
    }
    const profileKey = JSON.stringify(context.profile ?? {});
    if (profileKey !== lastProfile || languageChanged) {
      const profileChanged = profileKey !== lastProfile;
      lastProfile = profileKey;
      const profile = context.profile ?? {};
      $('.profile-summary').textContent = [profile.name || label(composer ? 'Открытый диалог' : 'Карточка профиля'), profile.age ? format('{{age}} лет', '{{age}} years old', { age: profile.age }) : '', profile.city].filter(Boolean).join(' · ');
      $('.bio').textContent = profile.bio || label('Описание профиля пока недоступно.');
      $('.xray').textContent = profile.idTimestamp ? format('Дата из структуры ID: {{date}}. Это предположение, а не подтверждённая дата регистрации.', 'Date inferred from ID: {{date}}. This is an inference, not a confirmed registration date.', { date: new Date(profile.idTimestamp).toLocaleDateString(uiLanguage()) }) : label('Дата по ID неизвестна.');
      const hint = languageHint(profile.bio);
      const language = hint.code ? new Intl.DisplayNames([uiLanguage()], { type: 'language' }).of(hint.code) : label('Недостаточно текста');
      $('.language-hint').textContent = format('Подсказка языка (эвристика): {{language}}', 'Language hint (heuristic): {{language}}', { language });
      if (profileChanged) {
        $('.bio-translation').textContent = '';
        $('.photos').replaceChildren(...(context.photos ?? []).slice(0, 20).map(url => Object.assign(document.createElement('img'), { src: url, alt: 'Фотография из открытого профиля', loading: 'lazy', referrerPolicy: 'no-referrer' })));
        $('.instagram-links').replaceChildren(...instagramLinks(profile.bio).map(({ handle, url }) => {
          const link = Object.assign(document.createElement('a'), { href: url, textContent: `Instagram: @${handle} ↗`, target: '_blank', rel: 'noopener noreferrer' });
          link.addEventListener('click', event => { if (!event.isTrusted) event.preventDefault(); }); return link;
        }));
      }
    }
    $('.coverage').textContent = format('{{count}} загруженных сообщений · {{source}} · история может быть неполной', '{{count}} loaded messages · {{source}} · history may be incomplete', { count: context.messages?.length ?? 0, source: label(context.source === 'loaded-app-state' ? 'состояние приложения' : 'видимая часть страницы') });
    const state = env.state();
    if (state) {
      const styles = active(state.styles).filter(style => (!style.shared || state.settings?.showSharedPrompts) && isStyleEligible(style, context));
      const styleSignature = JSON.stringify([uiLanguage(), ...styles.map(style => [style.id, style.name])]);
      if (styleSignature !== lastStyleSignature) {
        lastStyleSignature = styleSignature;
        const previous = $('.style').value;
        $('.style').replaceChildren(new Option(label('Общий'), ''), ...styles.map(style => new Option(style.name, style.id)));
        $('.style').value = styles.some(style => style.id === previous) ? previous : '';
      }
      const countSetting = state.settings?.suggestionCount ?? 3;
      if (savedCountSetting === null ? !manualCount : savedCountSetting !== countSetting) { $('.count').value = String(countSetting); if (savedCountSetting !== null) manualCount = false; }
      savedCountSetting = countSetting;
      const matches = context.profile?.id ? active(state.conversations).filter(conversation => conversation.chatId !== key && conversation.id !== key && conversation.profile?.id === context.profile.id).length : null;
      $('.encountered').textContent = matches === null ? label('Сопоставление с историей недоступно: нет ID профиля.') : format('Другие диалоги с этим профилем в вашей истории: {{count}}.', 'Other conversations with this profile in your history: {{count}}.', { count: matches });
    }
    if (state && state !== lastLibrary) {
      lastLibrary = state;
      $('.profile-details').hidden = state.settings?.showProfile === false;
      $('.tools').hidden = state.settings?.showTools === false;
      $('.external-section').hidden = state.settings?.showTools === false;
      $('.note-section').hidden = state.settings?.showNotes === false;
      $('.translation-section').hidden = state.settings?.showTranslation === false;
      $('.schedule-section').hidden = !composer || state.settings?.showSchedule === false;
      if (shadow.activeElement !== $('.note')) $('.note').value = state.notes?.[key]?.text ?? '';
      $('.blur').checked = Boolean(state.settings?.blurImages); $('.photos').classList.toggle('blurred', Boolean(state.settings?.blurImages));
      $('.geo-enabled').checked = Boolean(state.settings?.geo?.enabled);
      if (shadow.activeElement !== $('.latitude')) $('.latitude').value = state.settings?.geo?.latitude ?? 0;
      if (shadow.activeElement !== $('.longitude')) $('.longitude').value = state.settings?.geo?.longitude ?? 0;
      renderQueue();
    }
    if (languageChanged) renderQueue();
    localizeUI();
  }
  (composer?.closest('form, footer') ?? anchor).insertAdjacentElement('afterend', host);
  if (!composer) { $('.subtitle').textContent = 'Помощник карточки профиля'; $('.schedule-section').hidden = true; }
  update();
  return { host, composer, anchor, route, key, update, notify, remove() { disposed = true; requestNumber++; cancelGeneration?.(); clearPending(); host.remove(); } };
}

export function start() {
  if (stopCurrent) return stopCurrent;
  let mounted = null, frame = 0, queueTimer = 0, stopped = false, snapshot = null, library = null, loading = null, reloadAgain = false;
  const processing = new Set(), platform = platformFor(location);
  if (!platform) return () => {};
  const blurStyle = document.createElement('style');
  blurStyle.textContent = 'html[data-replylab-blur-images="true"] .recsCardboard__cardsContainer [style*="background-image"],html[data-replylab-blur-images="true"] main img[src*="gotinder.com"],html[data-replylab-blur-images="true"] #main header img{filter:blur(16px)!important}';
  document.head.append(blurStyle);
  function context() {
    if (snapshot?.route === location.pathname && snapshot.conversation) return snapshot.conversation;
    const rendered = renderedContext(document, location);
    if (rendered) return rendered;
    if (snapshot?.route === location.pathname && snapshot.profile) return { chatId: `profile:${snapshot.profile.id}`, platform, route: location.pathname,
      profile: snapshot.profile, photos: snapshot.profile.photos, messages: [], title: snapshot.profile.name || 'Карточка профиля', partial: true, source: snapshot.source };
    return null;
  }
  async function action(action, payload = {}) {
    const response = await chrome.runtime.sendMessage({ type: 'replylab:action', action, payload });
    if (!response?.ok) throw new Error(response?.error || 'Действие не выполнено.');
    if (response.state) { library = response.state; applySettings(); schedule(); }
    return response;
  }
  function applySettings() {
    document.documentElement.toggleAttribute('data-replylab-blur-images', Boolean(library?.settings?.blurImages));
    if (library?.settings?.blurImages) document.documentElement.setAttribute('data-replylab-blur-images', 'true');
    window.postMessage({ channel, kind: 'geo', value: validGeo(library?.settings?.geo) ? library.settings.geo : { enabled: false } }, location.origin);
  }
  async function loadLibrary() {
    if (loading) { reloadAgain = true; return loading; }
    loading = action('library').catch(error => mounted?.notify(error.message, true)).finally(() => {
      loading = null;
      if (reloadAgain && !stopped) { reloadAgain = false; loadLibrary(); }
    });
    return loading;
  }
  async function processQueue() {
    clearTimeout(queueTimer); queueTimer = 0;
    const current = context();
    if (!current || !library || document.visibilityState !== 'visible') return;
    const due = active(library.schedules).filter(item => item.chatId === current.chatId && item.platform === current.platform && item.status === 'scheduled');
    for (const item of due.filter(item => Date.parse(item.fireAt) <= Date.now())) {
      if (processing.has(item.id)) continue;
      processing.add(item.id);
      let claimed = false, claimAttempted = false;
      try {
        if (item.sendMode !== 'automatic' || !library.settings?.autoSendEnabled) { await action('complete-schedule', { id: item.id, status: 'ready' }); continue; }
        if (!canAutoSendContext(current)) throw new Error('Не удалось надёжно определить авторов и текущую историю. Автоматическая отправка отменена.');
        const composer = findComposer(document, location);
        if (!composer || draftText(composer).length) { await action('complete-schedule', { id: item.id, status: 'ready', error: 'В поле уже есть черновик.' }); continue; }
        if (item.incomingSnapshot !== incomingSnapshot(context())) throw new Error('Входящие сообщения изменились. Автоматическая отправка отменена.');
        claimAttempted = true;
        const response = await action('claim-schedule', { id: item.id, chatId: current.chatId, incomingSnapshot: incomingSnapshot(context()),
          expected: { fireAt: item.fireAt, text: item.text, updatedAt: item.updatedAt } });
        claimed = true;
        const actual = response.state?.schedules.find(record => record.id === item.id);
        if (!actual || actual.status !== 'firing' || actual.fireAt !== item.fireAt || actual.text !== item.text || actual.incomingSnapshot !== item.incomingSnapshot) throw new Error('Запись расписания изменилась. Отправка остановлена.');
        if (document.visibilityState !== 'visible' || context()?.chatId !== current.chatId || item.incomingSnapshot !== incomingSnapshot(context()) || composer !== findComposer(document, location) || draftText(composer).length) throw new Error('Диалог изменился после подтверждения очереди.');
        if (!insertReply(composer, item.text)) throw new Error('Не удалось подготовить черновик.');
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        await action('library');
        const latest = library?.schedules.find(record => record.id === item.id && !record.deleted);
        if (!latest || latest.status !== 'firing' || latest.fireAt !== actual.fireAt || latest.text !== actual.text || latest.updatedAt !== actual.updatedAt) throw new Error('Запись расписания изменилась перед отправкой.');
        if (!library.settings?.autoSendEnabled || document.visibilityState !== 'visible' || context()?.chatId !== current.chatId || item.incomingSnapshot !== incomingSnapshot(context()) || draftText(composer) !== item.text) throw new Error('Черновик, входящее сообщение или разрешение изменились.');
        const send = findSendButton(composer);
        if (!send) throw new Error('Кнопка отправки не найдена однозначно. Черновик оставлен для проверки.');
        send.click();
        await action('complete-schedule', { id: item.id, status: 'completed', error: 'Команда отправки выполнена. Проверьте подтверждение в диалоге; автоматически не повторяем.' });
      } catch (error) {
        if (!claimAttempted || claimed) await action('complete-schedule', { id: item.id, status: 'failed', error: error.message }).catch(() => {});
        mounted?.notify(error.message, true);
      } finally {
        processing.delete(item.id);
      }
    }
    const future = due.map(item => Date.parse(item.fireAt)).filter(time => time > Date.now());
    if (future.length) queueTimer = setTimeout(() => { loadLibrary().then(processQueue); }, Math.min(Math.min(...future) - Date.now() + 20, 2147483647));
  }
  function scan() {
    frame = 0;
    if (stopped) return;
    const composer = findComposer(document, location), anchor = composer ?? findProfileAnchor(document, location), data = context();
    if (mounted && (mounted.composer !== composer || mounted.anchor !== anchor || mounted.route !== location.href || mounted.key !== (data?.chatId ?? '') || !mounted.host.isConnected)) { mounted.remove(); mounted = null; }
    if (!mounted && anchor && data) mounted = createPanel(composer, anchor, { context, state: () => library, action, schedule });
    mounted?.update(); processQueue().catch(() => {});
  }
  function schedule() { if (!stopped && !frame) frame = requestAnimationFrame(scan); }
  const observer = new MutationObserver(schedule);
  observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true,
    attributeFilter: ['class', 'style', 'hidden', 'inert', 'disabled', 'readonly', 'aria-hidden', 'aria-disabled'] });
  const onMessage = event => {
    if (event.source !== window || event.origin !== location.origin || event.data?.channel !== channel) return;
    if (event.data.kind === 'geo-request' && ['getCurrentPosition', 'watchPosition'].includes(event.data.operation)) {
      action('record-event', { event: { kind: `geolocation:${event.data.operation}:${event.data.overridden === true ? 'override' : 'native'}`, platform, chatId: context()?.chatId ?? '', at: new Date().toISOString() } }).catch(() => {});
      return;
    }
    if (event.data.kind !== 'snapshot') return;
    snapshot = normalizeSiteSnapshot(event.data, location); schedule();
  };
  const onStorage = (changes, area) => { if (area === 'local' && changes.library) loadLibrary(); };
  const onSwipe = event => {
    if (!event.isTrusted || platform !== 'tinder' || !/^\/app\/recs/.test(location.pathname)) return;
    const target = event.target?.closest?.('button, [role="button"]');
    if (target?.closest('dialog, [role="dialog"], [aria-modal="true"]')) return;
    const label = (target?.getAttribute('aria-label') || target?.textContent || '').trim().toLowerCase();
    const kind = /^(nope|pass|dislike|не нравится|пропустить)(?:\s|$|\()/.test(label) ? 'pass-observed' : /^(like|нравится)(?:\s|$|\()/.test(label) ? 'like-observed' : null;
    if (kind) action('record-event', { event: { kind, platform, chatId: context()?.chatId ?? '', at: new Date().toISOString(), ...(context()?.profile ? { profile: context().profile } : {}) } }).catch(() => {});
  };
  window.addEventListener('message', onMessage); document.addEventListener('click', onSwipe, true); chrome.storage.onChanged.addListener(onStorage);
  const events = ['popstate', 'hashchange', 'pageshow', 'resize', 'visibilitychange'];
  events.forEach(event => window.addEventListener(event, schedule)); document.addEventListener('focusin', schedule);
  window.navigation?.addEventListener('currententrychange', schedule);
  stopCurrent = () => {
    if (stopped) return;
    stopped = true; observer.disconnect(); cancelAnimationFrame(frame); clearTimeout(queueTimer); mounted?.remove(); blurStyle.remove();
    document.documentElement.removeAttribute('data-replylab-blur-images'); window.postMessage({ channel, kind: 'geo', value: { enabled: false } }, location.origin);
    window.removeEventListener('message', onMessage); document.removeEventListener('click', onSwipe, true); chrome.storage.onChanged.removeListener(onStorage);
    events.forEach(event => window.removeEventListener(event, schedule)); document.removeEventListener('focusin', schedule);
    window.navigation?.removeEventListener('currententrychange', schedule); stopCurrent = null;
  };
  loadLibrary(); window.postMessage({ channel, kind: 'request' }, location.origin); schedule();
  return stopCurrent;
}
