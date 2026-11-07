import { LIMITS, renderStyle } from './library.js';
import { translate } from './locales.js';
import { aggregate90days } from './analytics.js';
import { incomingSnapshot } from './site-context.js';

const LANGUAGES = { ru: 'Русский', en: 'English', de: 'Deutsch', fr: 'Français', es: 'Español', pt: 'Português', da: 'Dansk', sv: 'Svenska', fi: 'Suomi', lt: 'Lietuvių', pl: 'Polski' };
const NAV = {
  ru: ['Начало', 'Стили', 'AI-помощник', 'История', 'Аналитика', 'Расписание', 'Настройки'],
  en: ['Start', 'Styles', 'AI assistant', 'History', 'Analytics', 'Schedule', 'Settings'],
  de: ['Start', 'Stile', 'KI-Assistent', 'Verlauf', 'Analyse', 'Zeitplan', 'Einstellungen'],
  fr: ['Accueil', 'Styles', 'Assistant IA', 'Historique', 'Statistiques', 'Planification', 'Réglages'],
  es: ['Inicio', 'Estilos', 'Asistente IA', 'Historial', 'Estadísticas', 'Programación', 'Ajustes'],
  pt: ['Início', 'Estilos', 'Assistente IA', 'Histórico', 'Estatísticas', 'Agendamento', 'Definições'],
  da: ['Start', 'Stilarter', 'AI-assistent', 'Historik', 'Analyse', 'Tidsplan', 'Indstillinger'],
  sv: ['Start', 'Stilar', 'AI-assistent', 'Historik', 'Statistik', 'Schema', 'Inställningar'],
  fi: ['Aloitus', 'Tyylit', 'Tekoälyavustaja', 'Historia', 'Tilastot', 'Aikataulu', 'Asetukset'],
  lt: ['Pradžia', 'Stiliai', 'DI asistentas', 'Istorija', 'Statistika', 'Tvarkaraštis', 'Nustatymai'],
  pl: ['Start', 'Style', 'Asystent AI', 'Historia', 'Statystyki', 'Harmonogram', 'Ustawienia'],
};
const TABS = ['start', 'styles', 'assistant', 'history', 'analytics', 'schedules', 'settings'];
const live = values => values.filter(item => !item.deleted);
const uuid = () => crypto.randomUUID();
const iso = () => new Date().toISOString();
const localDateTime = value => {
  const date = new Date(value);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
};
function node(tag, text, className) {
  const element = document.createElement(tag);
  if (text !== undefined) element.textContent = text;
  if (className) element.className = className;
  return element;
}
function download(value, name) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' }));
  const anchor = node('a'); anchor.href = url; anchor.download = name; anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export async function mountWorkspace(container, { rpc, stream }) {
  const stylesheetURL = new URL('./workspace.css', import.meta.url).href;
  if (![...document.querySelectorAll('link[rel=stylesheet]')].some(link => link.href === stylesheetURL)) {
    const link = node('link'); link.rel = 'stylesheet'; link.href = stylesheetURL; document.head.append(link);
  }
  const app = node('section', undefined, 'workspace-app');
  const toolbar = node('div', undefined, 'workspace-toolbar');
  const title = node('h2', 'ReplyLab Studio');
  const status = node('p', '', 'ws-status'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
  const tabs = node('nav', undefined, 'workspace-tabs'); tabs.setAttribute('aria-label', 'ReplyLab Studio');
  const panel = node('section', undefined, 'workspace-panel');
  toolbar.append(title);
  app.append(toolbar, tabs, status, panel); container.replaceChildren(app);
  let state, tab = 'start', selectedStyle = null, selectedChat = null, selectedConversation = null;
  let attachments = [], exported = false, fieldCount = 0, assistantSending = false, assistantController = null, onboardingStep = 0;
  const pendingNotes = new Map();
  const t = (ru, en) => translate(ru, en, state?.settings.language ?? 'ru');
  const say = (text, error = false) => { status.textContent = text; status.classList.toggle('error', error); };
  const raw = async (action, payload = {}) => {
    const result = await rpc(action, payload);
    if (result?.ok === false) throw new Error(result.error || 'Request failed');
    return result?.result ?? result;
  };
  const mutate = async (action, payload, refresh = true) => {
    const result = await raw(action, payload);
    if (result?.state?.version === 1) state = result.state;
    else if (result?.version === 1) state = result;
    if (refresh) render();
    say(t('Сохранено на устройстве.', 'Saved on this device.'));
    return result;
  };
  function button(label, run, primary = false) {
    const item = node('button', label, 'ws-button' + (primary ? ' ws-primary' : '')); item.type = 'button';
    item.addEventListener('click', async () => {
      item.disabled = true;
      try { await run(); } catch (error) { say(error.message, true); }
      finally { item.disabled = false; }
    });
    return item;
  }
  function field(label, value = '', options = {}) {
    const wrapper = node('div', undefined, 'ws-field' + (options.type === 'checkbox' ? ' ws-check' : ''));
    const caption = node('label', label), input = node(options.textarea ? 'textarea' : options.options ? 'select' : 'input');
    input.id = 'replylab-workspace-' + (++fieldCount); caption.htmlFor = input.id;
    if (options.options) for (const option of options.options) {
      const item = node('option', typeof option === 'string' ? option : option.label);
      item.value = typeof option === 'string' ? option : option.value; input.append(item);
    }
    if (options.type) input.type = options.type;
    if (options.type === 'checkbox') input.checked = Boolean(value); else input.value = String(value ?? '');
    for (const key of ['min', 'max', 'step', 'maxLength', 'rows', 'accept', 'multiple', 'required']) if (options[key] !== undefined) input[key] = options[key];
    wrapper.append(caption, input);
    return { wrapper, input };
  }
  function card(heading) { const item = node('article', undefined, 'ws-card'); if (heading) item.append(node('h3', heading)); return item; }
  function actions(...items) { const row = node('div', undefined, 'workspace-actions'); row.append(...items); return row; }
  function form(run) {
    const element = node('form');
    let busy = false;
    element.addEventListener('submit', async event => {
      event.preventDefault(); if (busy) return; busy = true;
      const buttons = [...element.querySelectorAll('button[type=submit]')]; buttons.forEach(item => { item.disabled = true; });
      try { await run(); } catch (error) { say(error.message, true); }
      finally { busy = false; buttons.forEach(item => { item.disabled = false; }); }
    });
    return element;
  }
  function submit(label) { const item = node('button', label, 'ws-button ws-primary'); item.type = 'submit'; return item; }
  function render() {
    tabs.replaceChildren(...TABS.map((key, index) => {
      const item = button((NAV[state.settings.language] ?? NAV.en)[index], () => { tab = key; render(); });
      item.setAttribute('aria-pressed', String(tab === key)); return item;
    }));
    panel.replaceChildren(); app.lang = state.settings.language;
    ({ start: startPage, styles: stylesPage, assistant: assistantPage, history: historyPage, analytics: analyticsPage, schedules: schedulesPage, settings: settingsPage })[tab]();
  }
  async function load() {
    const result = await raw('library'); state = result.state ?? result;
    if (state?.version !== 1) throw new Error('Library state is unavailable.');
    render();
  }
  toolbar.append(button('↻', load));
  toolbar.append(button('↓ JSON', async () => {
    await flushNotes();
    const response = await raw('export', { raw: true });
    download(response.state?.format ? response.state : response, 'replylab-recovery.json');
    say(t('Сохранена точная резервная копия. Импорт восстановления требует проверки структуры.', 'Exact backup saved. Recovery import requires validating its structure.'));
  }));
  function startPage() {
    panel.append(node('h3', t('От настроек до диалога', 'From settings to conversation')));
    if (state.settings.onboardingCompleted) {
      panel.append(node('p', t('Знакомство завершено. Настройки и история доступны во вкладках.', 'Introduction complete. Settings and history are available in the tabs.'), 'ws-card'),
        button(t('Пройти знакомство заново', 'Restart introduction'), async () => { onboardingStep = 0; await mutate('save-settings', { settings: { onboardingCompleted: false } }); }));
    } else {
      const progress = node('progress'); progress.max = 4; progress.value = onboardingStep + 1;
      progress.setAttribute('aria-label', t('Шаг знакомства', 'Introduction step'));
      const steps = [
        { text: t('Включите локальный доступ тестовым кодом в верхней части окна.', 'Enable local access with the test code at the top of the window.'),
          label: t('Перейти к коду', 'Go to test code'), run() { document.getElementById('code')?.focus(); } },
        { text: t('Выберите провайдера и модель либо оставьте локальный тест. Вернитесь на вкладку Начало.', 'Choose a provider and model or keep the local fixture. Return to Start afterwards.'),
          label: t('Открыть настройки', 'Open settings'), run() { tab = 'settings'; render(); } },
        { text: t('Можно добавить искусственный диалог: он помечен как тестовый и не связан с реальным аккаунтом.', 'You can add a synthetic conversation: it is marked as a fixture and is unrelated to a real account.'),
          label: t('Добавить тестовый диалог', 'Add synthetic conversation'), async run() {
            const captured = { chatId: 'replylab-demo', platform: 'manual', title: t('Тестовый диалог ReplyLab', 'ReplyLab synthetic conversation'),
              profile: { id: 'synthetic-profile', name: 'Alex', bio: t('Искусственный пример для знакомства.', 'Synthetic example for the introduction.') },
              messages: [{ id: 'demo-incoming', role: 'assistant', text: t('Привет! Чем тебе нравится заниматься в свободное время?', 'Hi! What do you enjoy doing in your free time?'), createdAt: null },
                { id: 'demo-outgoing', role: 'user', text: t('Люблю прогулки и музыку. А тебе?', 'I enjoy walking and music. How about you?'), createdAt: null }], partial: true };
            await mutate('capture', { conversation: captured }, false);
            selectedConversation = state.conversations.find(item => item.chatId === captured.chatId)?.id;
            tab = 'history'; render();
          } },
        { text: t('Создайте свой стиль, попробуйте помощника и экспортируйте библиотеку. Завершение сохранится на устройстве.', 'Create a style, try the assistant and export the library. Completion is saved on this device.'),
          label: t('Завершить знакомство', 'Complete introduction'), async run() { await mutate('save-settings', { settings: { onboardingCompleted: true } }); } },
      ];
      const current = steps[Math.min(onboardingStep, steps.length - 1)];
      const entry = card((onboardingStep + 1) + '/4');
      entry.append(node('p', current.text), actions(button(current.label, async () => {
        const before = onboardingStep; onboardingStep = Math.min(onboardingStep + 1, 3);
        try { await current.run(); if (tab === 'start' && !state.settings.onboardingCompleted) render(); }
        catch (error) { onboardingStep = before; throw error; }
      }, true), button(t('Назад', 'Back'), () => { onboardingStep = Math.max(0, onboardingStep - 1); render(); })));
      panel.append(progress, entry);
    }
    panel.append(node('p', t('Локальные данные остаются на устройстве до явного включения синхронизации или создания ссылки. Режим автоотправки изначально выключен.', 'Local data stays on this device until you explicitly enable sync or create a link. Automatic sending starts disabled.'), 'ws-muted'));
  }
  function stylesPage() {
    const styles = live(state.styles).filter(item => !item.shared || state.settings.showSharedPrompts);
    const row = actions(button(t('Новый стиль', 'New style'), () => { selectedStyle = null; stylesEditor({}); }));
    panel.append(row);
    for (const item of styles) {
      const entry = card(item.name); entry.append(node('p', item.prompt.slice(0, 140), 'ws-muted'));
      entry.append(actions(
        button(t('Редактировать', 'Edit'), () => { selectedStyle = item.id; stylesEditor(item); }),
        button(t('Копия', 'Duplicate'), () => mutate('duplicate-style', { id: item.id })),
        button(t('Удалить', 'Delete'), () => { if (confirm(t('Удалить стиль?', 'Delete this style?'))) return mutate('delete-style', { id: item.id }); }),
      )); panel.append(entry);
    }
    const edit = styles.find(item => item.id === selectedStyle);
    if (edit) stylesEditor(edit); else if (!styles.length) stylesEditor({});
  }
  function stylesEditor(item) {
    panel.querySelector('[data-style-editor]')?.remove();
    const edit = card(t('Редактор стиля', 'Style editor')); edit.dataset.styleEditor = '';
    const fields = {
      name: field(t('Название', 'Name'), item.name, { required: true, maxLength: 120 }),
      prompt: field(t('Инструкция', 'Prompt'), item.prompt, { textarea: true, rows: 6, maxLength: 20000 }),
      model: field(t('Модель (пусто = модель подсказок)', 'Model (empty = suggestion model)'), item.model),
      temperature: field(t('Температура', 'Temperature'), item.temperature ?? 0.7, { type: 'number', min: 0, max: 2, step: 0.1 }),
      maxTokens: field(t('Лимит токенов', 'Token limit'), item.maxTokens ?? 1000, { type: 'number', min: 16, max: 16000 }),
      suggestionCount: field(t('Количество ответов', 'Reply count'), item.suggestionCount ?? 3, { type: 'number', min: 1, max: 3 }),
      shared: field(t('Показывать в локальном общем каталоге', 'Show in local shared catalog'), item.shared, { type: 'checkbox' }),
      useHistory: field(t('Включать похожие мои прошлые ответы в контекст', 'Include similar previous replies of mine in context'), item.useHistory, { type: 'checkbox' }),
    };
    const conditions = ['opener', 'incoming', 'stale', 'empty'].map(value => ({ value, ...field(value, (item.conditions ?? ['opener', 'incoming', 'stale', 'empty']).includes(value), { type: 'checkbox' }) }));
    const previewName = field('{{name}}', 'Alex'), previewBio = field('{{bio}}', ''), previewTranscript = field('{{transcript}}', '', { textarea: true, rows: 2 });
    const preview = node('pre', '', 'ws-preview');
    const updatePreview = () => { const chatId = state.conversations.find(value => value.id === selectedConversation)?.chatId;
      preview.textContent = renderStyle(fields.prompt.input.value, { name: previewName.input.value, bio: previewBio.input.value, transcript: previewTranscript.input.value, notes: state.notes[chatId]?.text ?? '', memories: live(state.memories).filter(value => value.enabled).map(value => value.text).join('\n') }); };
    const editor = form(async () => {
      const value = { ...item, name: fields.name.input.value, prompt: fields.prompt.input.value, model: fields.model.input.value,
        temperature: Number(fields.temperature.input.value), maxTokens: Number(fields.maxTokens.input.value), suggestionCount: Number(fields.suggestionCount.input.value),
        shared: fields.shared.input.checked, useHistory: fields.useHistory.input.checked,
        conditions: conditions.filter(value => value.input.checked).map(value => value.value) };
      await mutate('save-style', { style: value });
    });
    Object.values(fields).forEach(value => editor.append(value.wrapper));
    editor.append(node('p', '{{name}} · {{bio}} · {{transcript}} · {{notes}} · {{memories}}', 'ws-muted'));
    editor.append(...conditions.map(value => value.wrapper), submit(t('Сохранить стиль', 'Save style')));
    const previewBox = node('details'); previewBox.append(node('summary', t('Предпросмотр переменных', 'Variable preview')), previewName.wrapper, previewBio.wrapper, previewTranscript.wrapper, preview);
    [fields.prompt.input, previewName.input, previewBio.input, previewTranscript.input].forEach(input => input.addEventListener('input', updatePreview));
    updatePreview(); edit.append(editor, previewBox); panel.append(edit);
  }
  function assistantPage() {
    const chats = live(state.assistantChats), chat = chats.find(item => item.id === selectedChat) ?? chats[0];
    if (chat) selectedChat = chat.id;
    panel.append(actions(button(t('Новый диалог', 'New chat'), async () => {
      const fresh = { id: uuid(), title: t('Новый диалог', 'New chat'), model: state.settings.assistantModel, messages: [] };
      attachments = []; selectedChat = fresh.id; await mutate('save-chat', { chat: fresh });
    })));
    const selection = field(t('Диалог (до 20)', 'Chat (up to 20)'), chat?.id ?? '', { options: chats.map(item => ({ value: item.id, label: item.title })) });
    selection.input.addEventListener('change', () => { attachments = []; selectedChat = selection.input.value; render(); }); panel.append(selection.wrapper);
    if (!chat) { panel.append(node('p', t('Создайте первый диалог.', 'Create your first chat.'))); return; }
    const titleField = field(t('Название диалога', 'Chat title'), chat.title, { maxLength: 150 });
    titleField.input.addEventListener('change', () => mutate('save-chat', { chat: { ...chat, title: titleField.input.value } }).catch(error => say(error.message, true)));
    panel.append(titleField.wrapper, node('p', chat.messages.length + '/40 ' + t('сообщений. Перед удалением экспортируйте историю.', 'messages. Export history before deletion.'), 'ws-muted'));
    const messages = node('div', undefined, 'ws-list');
    for (const message of chat.messages) {
      const entry = node('div', undefined, 'ws-message ' + message.role);
      entry.append(node('small', message.role), node('p', message.text));
      for (const file of message.attachments ?? []) entry.append(node('small', file.name + ' · ' + file.mimeType));
      messages.append(entry);
    }
    panel.append(messages);
    const context = field(t('Контекст из сохранённого чата', 'Saved conversation context'), selectedConversation ?? '', { options: [{ value: '', label: '—' }, ...live(state.conversations).map(item => ({ value: item.id, label: item.title || item.chatId }))] });
    context.input.addEventListener('change', () => { selectedConversation = context.input.value; });
    const input = field(t('Сообщение (до 10 000 символов)', 'Message (up to 10,000 characters)'), '', { textarea: true, rows: 4, maxLength: 10000, required: true });
    const files = field(t('Вложения: до 4 файлов, 1 МБ каждый; изображения или текст', 'Attachments: up to 4 files, 1 MB each; images or text'), '', { type: 'file', accept: 'image/png,image/jpeg,image/webp,image/gif,text/plain,text/markdown,.md,.txt', multiple: true });
    const fileList = node('div', '', 'ws-muted');
    files.input.addEventListener('change', async () => {
      try {
        const selected = [...files.input.files];
        if (selected.length > LIMITS.attachments || selected.some(file => file.size > LIMITS.attachmentBytes)) throw new Error(t('Превышен лимит вложений.', 'Attachment limit exceeded.'));
        attachments = await Promise.all(selected.map(async file => {
          if (file.type.startsWith('image/')) {
            const dataUrl = await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = reject; reader.readAsDataURL(file); });
            return { name: file.name, mimeType: file.type, dataUrl };
          }
          return { name: file.name, mimeType: 'text/plain', text: await file.text() };
        }));
        fileList.textContent = attachments.map(file => file.name).join(', ');
      } catch (error) { attachments = []; files.input.value = ''; say(error.message, true); }
    });
    const send = async operation => {
      if (assistantSending) throw new Error(t('Дождитесь ответа помощника.', 'Wait for the assistant response.'));
      if (!input.input.value.trim()) throw new Error(t('Введите сообщение.', 'Enter a message.'));
      if (chat.messages.length > 38) throw new Error(t('Лимит 40 сообщений. Экспортируйте и начните новый диалог.', '40-message limit reached. Export and start a new chat.'));
      assistantSending = true;
      try {
      const instruction = operation === 'translate' ? 'Translate the following text to ' + state.settings.language + ':\n' : operation === 'summarize' ? 'Summarize the following conversation:\n' : operation === 'style' ? 'Write a reusable reply style instruction from:\n' : '';
      if ((instruction + input.input.value).length > 10000) throw new Error(t('Сократите сообщение: вместе с инструкцией лимит 10 000 символов.', 'Shorten the message: the instruction and message must fit 10,000 characters.'));
      const userMessage = { id: uuid(), role: 'user', text: instruction + input.input.value, attachments, createdAt: iso() };
      const pendingChat = { ...chat, model: state.settings.assistantModel || chat.model, messages: [...chat.messages, userMessage] };
      await mutate('save-chat', { chat: pendingChat }, false);
      const conversation = live(state.conversations).find(item => item.id === context.input.value);
      say(t('Готовим ответ…', 'Generating…'));
      const payload = { messages: pendingChat.messages, context: conversation ?? null, model: pendingChat.model,
        systemPrompt: state.settings.systemPrompt, memories: live(state.memories).filter(item => item.enabled).map(item => item.text), notes: state.notes[conversation?.chatId]?.text ?? '' };
      assistantController = new AbortController();
      const preview = node('div', '', 'ws-message assistant');
      preview.setAttribute('aria-live', 'polite');
      const cancel = button(t('Остановить генерацию', 'Stop generation'), () => assistantController?.abort());
      panel.append(preview, cancel);
      let response;
      try {
        response = stream ? await stream('assistant', payload, {
          signal: assistantController.signal,
          onDelta: delta => { preview.textContent += typeof delta === 'string' ? delta : delta?.text ?? ''; },
        }) : await raw('assistant', payload);
      } finally { cancel.remove(); }
      if (response?.ok === false) throw new Error(response.error || 'Generation failed');
      const answer = response.text ?? response.answer ?? response.response?.text;
      if (typeof answer !== 'string' || !answer.trim()) throw new Error(t('Пустой ответ помощника.', 'The assistant returned an empty response.'));
      await mutate('save-chat', { chat: { ...pendingChat, messages: [...pendingChat.messages, { id: uuid(), role: 'assistant', text: answer, createdAt: iso() }] } });
      attachments = [];
      if (operation === 'style') await mutate('save-style', { style: { name: t('Из AI-помощника', 'From AI assistant'), prompt: answer } });
      } finally { assistantSending = false; assistantController = null; }
    };
    const composer = form(() => send('chat'));
    input.input.addEventListener('keydown', event => {
      if (state.settings.sendOnEnter && event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); composer.requestSubmit(); }
    });
    composer.append(context.wrapper, input.wrapper, files.wrapper, fileList, submit(t('Отправить помощнику', 'Send to assistant')),
      actions(button(t('Перевести', 'Translate'), () => send('translate')), button(t('Резюме', 'Summarize'), () => send('summarize')), button(t('Создать стиль', 'Create style'), () => send('style'))));
    panel.append(composer, button(t('Удалить диалог', 'Delete chat'), () => { if (confirm(t('Удалить AI-диалог?', 'Delete this AI chat?'))) return mutate('delete-chat', { id: chat.id }); }));
  }
  function historyPage() {
    const search = field(t('Поиск по сообщениям, профилям и заметкам', 'Search messages, profiles and notes'), '');
    const results = node('div', undefined, 'ws-list');
    const renderResults = () => {
      const query = search.input.value.trim().toLocaleLowerCase();
      const matches = live(state.conversations).filter(item => JSON.stringify([item.title, item.profile, item.messages, state.notes[item.chatId]]).toLocaleLowerCase().includes(query));
      results.replaceChildren();
      for (const item of matches) {
        const entry = card(item.title || item.chatId);
        entry.append(node('p', item.platform + ' · ' + item.messages.length + ' ' + t('сообщений', 'messages') + (item.partial ? ' · ' + t('частичный снимок', 'partial capture') : ''), 'ws-muted'));
        const show = node('details'); show.append(node('summary', t('Показать переписку', 'Show conversation')));
        for (const message of item.messages) show.append(node('p', message.role + ': ' + message.text, 'ws-message'));
        const note = field(t('Заметка к диалогу (автосохранение)', 'Conversation note (autosave)'), state.notes[item.chatId]?.text ?? '', { textarea: true, rows: 3, maxLength: 30000 });
        note.input.addEventListener('input', () => {
          const old = pendingNotes.get(item.chatId); clearTimeout(old?.timer);
          pendingNotes.set(item.chatId, { text: note.input.value, timer: setTimeout(() => saveNote(item.chatId).catch(error => say(error.message, true)), 500) });
        });
        const ttl = field(t('Ссылка: срок в часах', 'Share link: hours'), 24, { type: 'number', min: 1, max: 168 });
        const linkBox = node('div', '', 'ws-muted');
        entry.append(show, note.wrapper, ttl.wrapper, linkBox, actions(
          button(t('Экспорт чата', 'Export chat'), async () => { await saveNote(item.chatId); download({ version: 1, conversations: [item], notes: { [item.chatId]: state.notes[item.chatId] ?? { text: '', updatedAt: iso() } } }, 'replylab-conversation.json'); }),
          button(t('Создать ссылку', 'Create link'), async () => {
            const response = await raw('share', { conversation: item, ttlSeconds: Number(ttl.input.value) * 3600 });
            if (!response.url) throw new Error('Share URL is unavailable.');
            const anchor = node('a', response.url); anchor.href = response.url; anchor.rel = 'noreferrer'; anchor.target = '_blank';
            linkBox.replaceChildren(anchor, button(t('Отозвать', 'Revoke'), async () => { await raw('revoke-share', { id: response.id }); linkBox.textContent = t('Ссылка отозвана.', 'Link revoked.'); }));
          }),
          button(t('Использовать в помощнике', 'Use in assistant'), () => { selectedConversation = item.id; tab = 'assistant'; render(); }),
        )); results.append(entry);
      }
      if (!matches.length) results.append(node('p', t('Диалоги ещё не сохранены или ничего не найдено.', 'No conversations saved or no matches.')));
    };
    search.input.addEventListener('input', renderResults);
    panel.append(search.wrapper, actions(
      button(t('Поиск на сервере', 'Search server'), async () => {
        const response = await raw('search', { query: search.input.value });
        results.replaceChildren(...(response.results ?? []).map(item => node('p', item.type + ': ' + item.text, 'ws-card')));
      }),
      button(t('Экспорт библиотеки', 'Export library'), exportLibrary),
    ), results); renderResults();
    const upload = field(t('Импорт JSON библиотеки или диалога', 'Import library or conversation JSON'), '', { type: 'file', accept: 'application/json,.json' });
    const replace = field(t('Заменить библиотеку (сначала экспортируйте)', 'Replace library (export first)'), false, { type: 'checkbox' });
    panel.append(upload.wrapper, replace.wrapper, button(t('Импортировать', 'Import'), async () => {
      await flushNotes();
      const file = upload.input.files[0]; if (!file || file.size > LIMITS.stateBytes) throw new Error(t('Выберите JSON до 8 МБ.', 'Choose a JSON file up to 8 MB.'));
      if (replace.input.checked && !exported) throw new Error(t('Сначала экспортируйте текущую библиотеку.', 'Export the current library first.'));
      const data = JSON.parse(await file.text());
      await mutate('import', { data, mode: replace.input.checked ? 'replace' : 'merge', confirmReplace: replace.input.checked });
    }));
  }
  async function saveNote(chatId) {
    const pending = pendingNotes.get(chatId); if (!pending) return;
    clearTimeout(pending.timer); pendingNotes.delete(chatId);
    try { await mutate('save-note', { chatId, text: pending.text }, false); }
    catch (error) { if (!pendingNotes.has(chatId)) pendingNotes.set(chatId, { text: pending.text, timer: null }); throw error; }
  }
  async function flushNotes() {
    for (const chatId of [...pendingNotes.keys()]) await saveNote(chatId);
  }
  async function exportLibrary() {
    await flushNotes();
    const response = await raw('export');
    const payload = response.state?.format ? response.state : response;
    download(payload, 'replylab-library-' + new Date().toISOString().slice(0, 10) + '.json'); exported = true;
    say(t('Экспорт подготовлен. Проверьте сохранённый файл.', 'Export prepared. Verify the saved file.'));
  }
  function analyticsPage() {
    const zone = field(t('Часовой пояс аналитики', 'Analytics time zone'), Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC');
    const body = node('div', undefined, 'ws-list');
    const server = node('pre', '', 'ws-preview');
    function chart(heading, entries, second = false) {
      const figure = node('figure', undefined, 'ws-analytics-chart'); figure.append(node('figcaption', heading));
      const ns = 'http://www.w3.org/2000/svg';
      const svg = document.createElementNS(ns, 'svg'); svg.setAttribute('viewBox', '0 0 660 185');
      svg.setAttribute('role', 'img');
      svg.setAttribute('aria-label', heading + '. ' + entries.map(entry => entry.label + ': ' + (second
        ? t('Лайки', 'Likes') + ' ' + entry.value + ', ' + t('Пропуски', 'Passes') + ' ' + (entry.other ?? 0)
        : entry.value)).join('; '));
      const maximum = Math.max(...entries.flatMap(entry => [entry.value, second ? entry.other ?? 0 : 0]), 1);
      const width = 620 / Math.max(entries.length, 1), tickEvery = Math.max(1, Math.ceil(entries.length / 10));
      entries.forEach((entry, index) => {
        for (const [series, value] of [[0, entry.value], ...(second ? [[1, entry.other ?? 0]] : [])]) {
          const rect = document.createElementNS(ns, 'rect'), height = value / maximum * 130;
          rect.setAttribute('x', String(20 + width * index + series * width / 2)); rect.setAttribute('y', String(145 - height));
          rect.setAttribute('width', String(Math.max(1, width / (second ? 2 : 1) - 1))); rect.setAttribute('height', String(height));
          rect.setAttribute('fill', series ? '#a2b3c9' : '#315cfa');
          const title = document.createElementNS(ns, 'title'); title.textContent = entry.label + ': ' + value; rect.append(title); svg.append(rect);
        }
        if (index % tickEvery === 0) {
          const label = document.createElementNS(ns, 'text'); label.setAttribute('x', String(20 + width * index));
          label.setAttribute('y', '165'); label.setAttribute('font-size', '10'); label.textContent = entry.label.slice(0, 12); svg.append(label);
        }
      });
      figure.append(svg); return figure;
    }
    const renderAnalytics = () => {
      const data = aggregate90days(live(state.events), zone.input.value.trim(), Date.now());
      const number = value => new Intl.NumberFormat(state.settings.language, { maximumFractionDigits: 1 }).format(value);
      const grid = node('div', undefined, 'ws-grid');
      const metrics = [
        [t('Наблюдаемые решения', 'Observed decisions'), data.swipes],
        [t('Лайки', 'Likes'), data.likes], [t('Пропуски', 'Passes'), data.passes],
        [t('Доля лайков', 'Like rate'), data.likeRate === null ? t('Нет данных', 'No data') : number(data.likeRate * 100) + '%'],
        [t('Активные дни', 'Active days'), data.activeDays],
        [t('Самая длинная серия дней', 'Longest day streak'), data.longestStreak],
        [t('Текущая серия дней', 'Current day streak'), data.currentStreak],
        [t('Последние 30 / предыдущие 30 дней', 'Last 30 / previous 30 days'), data.last30 + ' / ' + data.previous30],
        [t('Изменение активности', 'Activity trend'), data.trendPercent === null ? t('Нет базы для сравнения', 'No comparison baseline') : number(data.trendPercent) + '%'],
      ];
      for (const [label, value] of metrics) { const item = card(label); item.append(node('p', String(value), 'ws-count')); grid.append(item); }
      body.replaceChildren(grid);
      body.append(chart(t('Решения за 90 дней', 'Decisions over 90 days'), Object.entries(data.days).map(([day, value]) => ({ label: day.slice(5), value }))),
        chart(t('Часы активности', 'Activity by hour'), data.hours.map((value, hour) => ({ label: String(hour).padStart(2, '0') + ':00', value }))),
        chart(t('Дни недели', 'Weekdays'), data.weekdays.map((value, index) => ({ label: new Intl.DateTimeFormat(state.settings.language, { weekday: 'short', timeZone: 'UTC' }).format(new Date(Date.UTC(2023, 0, 1 + index))), value }))));
      const taste = card(t('Наблюдаемые предпочтения', 'Observed preferences'));
      taste.append(node('p', t('Только метаданные профилей сохранённых решений. Отсутствующие данные не угадываются.', 'Only profile metadata attached to saved decisions. Missing data is not inferred.'), 'ws-muted'),
        node('p', t('Лайки с известным / неизвестным возрастом', 'Likes with known / unknown age') + ': ' + data.taste.knownAge + ' / ' + data.taste.unknownAge),
        node('p', t('Лайки с известным / неизвестным городом', 'Likes with known / unknown city') + ': ' + data.taste.knownCity + ' / ' + data.taste.unknownCity),
        node('p', t('Синий: лайки. Серый: пропуски.', 'Blue: likes. Gray: passes.'), 'ws-muted'),
        chart(t('Возрастные группы', 'Age groups'), data.taste.ageBands.map(item => ({ label: item.label, value: item.likes, other: item.passes })), true));
      if (data.taste.cities.length) taste.append(chart(t('Города: первые 10 по числу наблюдений', 'Cities: top 10 by observations'), data.taste.cities.slice(0, 10).map(item => ({ label: item.name, value: item.likes, other: item.passes })), true));
      body.append(taste);
    };
    zone.input.addEventListener('change', () => { try { renderAnalytics(); } catch (error) { say(error.message, true); } });
    panel.append(node('h3', t('Наблюдаемые события', 'Observed events')),
      node('p', t('Счётчики отражают только сохранённые события, а не полную статистику аккаунта.', 'Counters reflect saved events, not complete account statistics.'), 'ws-muted'),
      zone.wrapper, button(t('Получить аналитику сервера', 'Load server analytics'), async () => { server.textContent = JSON.stringify(await raw('analytics', { timeZone: zone.input.value.trim() }), null, 2); }),
      body, server);
    renderAnalytics();
  }
  function schedulesPage() {
    panel.append(node('h3', t('Очередь запланированных ответов', 'Scheduled replies')));
    const chat = field(t('ID диалога', 'Conversation ID'), '', { required: true, maxLength: 200 });
    const platform = field(t('Платформа', 'Platform'), 'manual', { options: ['manual', 'tinder', 'whatsapp'] });
    const body = field(t('Текст ответа', 'Reply text'), '', { textarea: true, rows: 3, required: true, maxLength: 10000 });
    const when = field(t('Когда', 'When'), '', { type: 'datetime-local', required: true });
    const automatic = field(t('Автоматическое выполнение (требует отдельного включения в настройках)', 'Automatic execution (requires enabling in settings)'), false, { type: 'checkbox' });
    const variation = field(t('Вариация времени, секунд (0–3600)', 'Timing variation, seconds (0–3600)'), 0, { type: 'number', min: 0, max: 3600, step: 1 });
    const skip = field(t('Отменять при новом входящем сообщении', 'Cancel when a new message arrives'), true, { type: 'checkbox' });
    automatic.input.addEventListener('change', () => { if (automatic.input.checked) skip.input.checked = true; skip.input.disabled = automatic.input.checked; });
    const editor = form(async () => {
      const fireAt = new Date(when.input.value);
      if (!Number.isFinite(fireAt.getTime()) || fireAt.getTime() <= Date.now()) throw new Error(t('Выберите время в будущем.', 'Choose a future time.'));
      const captured = live(state.conversations).find(item => item.chatId === chat.input.value && item.platform === platform.input.value);
      if (automatic.input.checked && !captured) throw new Error(t('Для автоматического режима сначала сохраните диалог или создайте запись в панели чата.', 'For automatic mode, save the conversation first or schedule from the chat panel.'));
      if (automatic.input.checked && !captured?.accountId) throw new Error(t('Для автоматического режима нужен проверенный аккаунт. Создайте запись в открытом чате.', 'Automatic mode requires a verified account. Schedule from the open chat.'));
      await mutate('schedule', { item: { chatId: chat.input.value, platform: platform.input.value, text: body.input.value, fireAt: fireAt.toISOString(),
        sendMode: automatic.input.checked ? 'automatic' : 'review', incomingSnapshot: captured ? incomingSnapshot(captured) : '',
        variationSeconds: Number(variation.input.value), skipIfNewMessage: skip.input.checked } });
    });
    const tomorrow = () => { const date = new Date(); date.setDate(date.getDate() + 1); date.setHours(9, 0, 0, 0); return date; };
    editor.append(chat.wrapper, platform.wrapper, body.wrapper, when.wrapper, actions(
      button(t('Через час', 'In one hour'), () => { when.input.value = localDateTime(Date.now() + 3600000); }),
      button(t('Завтра в 09:00', 'Tomorrow at 09:00'), () => { when.input.value = localDateTime(tomorrow()); }),
    ), variation.wrapper, skip.wrapper, automatic.wrapper, submit(t('Запланировать', 'Schedule'))); panel.append(editor);
    for (const item of live(state.schedules).sort((a, b) => a.fireAt.localeCompare(b.fireAt))) {
      const entry = card(item.chatId + ' · ' + item.status); entry.append(node('p', new Date(item.fireAt).toLocaleString() + ' · ' + item.sendMode + ' · ±' + item.variationSeconds + 's', 'ws-muted'), node('p', item.text));
      const time = field(t('Новое время', 'New time'), localDateTime(item.fireAt), { type: 'datetime-local' });
      entry.append(time.wrapper, actions(button(t('Перенести', 'Reschedule'), () => mutate('reschedule', { id: item.id, fireAt: new Date(time.input.value).toISOString() })), button(t('Отменить', 'Cancel'), () => mutate('cancel-schedule', { id: item.id }))));
      if (item.error) entry.append(node('p', item.error, 'ws-muted')); panel.append(entry);
    }
  }
  function settingsPage() {
    const settings = state.settings;
    const geoRequests = live(state.events).filter(item => item.kind.startsWith('geolocation:')).slice(-50).reverse();
    if (geoRequests.length) {
      const history = node('details'); history.append(node('summary', 'Geolocation API · ' + geoRequests.length),
        node('pre', geoRequests.map(item => item.at + ' · ' + item.kind).join('\n'), 'ws-preview'));
      panel.append(history);
    }
    const fields = {
      language: field(t('Язык', 'Language'), settings.language, { options: Object.entries(LANGUAGES).map(([value, label]) => ({ value, label })) }),
      provider: field(t('Провайдер', 'Provider'), settings.provider, { options: ['openai', 'openrouter', 'compatible', 'chatgpt'] }),
      suggestionProvider: field(t('Провайдер подсказок', 'Suggestion provider'), settings.suggestionProvider, { options: [{ value: '', label: t('Наследовать общий', 'Inherit main provider') }, ...['openai', 'openrouter', 'compatible', 'chatgpt']] }),
      assistantProvider: field(t('Провайдер помощника', 'Assistant provider'), settings.assistantProvider, { options: [{ value: '', label: t('Наследовать общий', 'Inherit main provider') }, ...['openai', 'openrouter', 'compatible', 'chatgpt']] }),
      suggestionModel: field(t('Модель подсказок', 'Suggestion model'), settings.suggestionModel),
      assistantModel: field(t('Модель помощника', 'Assistant model'), settings.assistantModel),
      systemPrompt: field(t('Системная инструкция', 'System prompt'), settings.systemPrompt, { textarea: true, rows: 5, maxLength: 30000 }),
      suggestionCount: field(t('Количество подсказок', 'Suggestion count'), settings.suggestionCount, { type: 'number', min: 1, max: 3 }),
      showSharedPrompts: field(t('Общие стили моей библиотеки', 'Shared styles in my library'), settings.showSharedPrompts, { type: 'checkbox' }),
      sendOnEnter: field(t('Enter отправляет запрос AI-помощнику, Shift+Enter переносит строку', 'Enter sends to the AI assistant; Shift+Enter adds a line'), settings.sendOnEnter, { type: 'checkbox' }),
      showProfile: field(t('Показывать профиль в панели', 'Show profile in the panel'), settings.showProfile, { type: 'checkbox' }),
      showTools: field(t('Показывать действия с историей', 'Show history actions'), settings.showTools, { type: 'checkbox' }),
      showNotes: field(t('Показывать заметки', 'Show notes'), settings.showNotes, { type: 'checkbox' }),
      showTranslation: field(t('Показывать перевод', 'Show translation'), settings.showTranslation, { type: 'checkbox' }),
      showSchedule: field(t('Показывать расписание', 'Show schedule'), settings.showSchedule, { type: 'checkbox' }),
      devMode: field(t('Режим диагностики', 'Diagnostics mode'), settings.devMode, { type: 'checkbox' }),
      blurImages: field(t('Размывать фотографии', 'Blur photos'), settings.blurImages, { type: 'checkbox' }),
      autoSendEnabled: field(t('Разрешить автоотправку запланированных сообщений', 'Allow automatic sending of scheduled messages'), settings.autoSendEnabled, { type: 'checkbox' }),
      syncEnabled: field(t('Разрешить синхронизацию с моим сервером', 'Allow sync with my server'), settings.syncEnabled, { type: 'checkbox' }),
      serverUrl: field(t('Адрес моего сервера', 'My server URL'), settings.serverUrl, { type: 'url' }),
      geoEnabled: field(t('Подмена координат на странице', 'Override page coordinates'), settings.geo.enabled, { type: 'checkbox' }),
      latitude: field(t('Широта', 'Latitude'), settings.geo.latitude, { type: 'number', min: -90, max: 90, step: 'any' }),
      longitude: field(t('Долгота', 'Longitude'), settings.geo.longitude, { type: 'number', min: -180, max: 180, step: 'any' }),
      accuracy: field(t('Точность, м', 'Accuracy, m'), settings.geo.accuracy, { type: 'number', min: 0, max: 100000 }),
    };
    const editor = form(async () => {
      const next = Object.fromEntries(Object.entries(fields).filter(([key]) => !['geoEnabled', 'latitude', 'longitude', 'accuracy'].includes(key)).map(([key, value]) => [key, value.input.type === 'checkbox' ? value.input.checked : key === 'suggestionCount' ? Number(value.input.value) : value.input.value]));
      next.geo = { enabled: fields.geoEnabled.input.checked, latitude: Number(fields.latitude.input.value), longitude: Number(fields.longitude.input.value), accuracy: Number(fields.accuracy.input.value) };
      if (next.autoSendEnabled && !settings.autoSendEnabled && !confirm(t('Включить автоматическую отправку для записей с режимом automatic?', 'Enable automatic sending for items explicitly marked automatic?'))) return;
      await mutate('save-settings', { settings: next });
    });
    Object.values(fields).forEach(value => editor.append(value.wrapper)); editor.append(submit(t('Сохранить настройки', 'Save settings'))); panel.append(editor);
    panel.append(node('p', t('Интерфейс доступен на 11 языках.', 'The interface is available in 11 languages.'), 'ws-muted'));
    const models = node('pre', '', 'ws-preview'), serverStatus = node('pre', '', 'ws-preview'), usage = node('pre', '', 'ws-preview');
    panel.append(actions(
      button(t('Список моделей', 'List models'), async () => { const result = await raw('provider-models', { provider: fields.provider.input.value }); models.textContent = (result.models ?? result.data ?? []).map(item => typeof item === 'string' ? item : item.id).join('\n'); }),
      button(t('Лимиты и использование провайдера', 'Provider limits and usage'), async () => { usage.textContent = JSON.stringify(await raw('provider-usage', { provider: fields.provider.input.value }), null, 2); }),
      button(t('Проверить сервер', 'Check server'), async () => { serverStatus.textContent = JSON.stringify(await raw('server-status'), null, 2); }),
      button(t('Синхронизировать сейчас', 'Sync now'), async () => {
        if (!settings.syncEnabled) throw new Error(t('Сначала разрешите и сохраните синхронизацию.', 'Enable and save sync first.'));
        const result = await raw('sync', { state });
        if (result.state) await mutate('import', { data: result.state, mode: 'merge' });
      }),
      button(t('Экспорт', 'Export'), exportLibrary),
    ), models, usage, serverStatus);
    if (settings.devMode) {
      const diagnostic = node('details'), data = node('pre', '', 'ws-preview');
      data.textContent = JSON.stringify({ version: state.version, collections: Object.fromEntries(['styles', 'memories', 'assistantChats', 'conversations', 'events', 'schedules'].map(key => [key, live(state[key]).length])), settings: state.settings }, null, 2);
      diagnostic.append(node('summary', t('Диагностика библиотеки', 'Library diagnostics')), data); panel.append(diagnostic);
    }
    const connections = card(t('Подключения OAuth', 'OAuth connections'));
    const accountList = node('div', undefined, 'ws-list');
    const refreshAccounts = async () => {
      const response = await raw('oauth-status');
      accountList.replaceChildren();
      for (const account of response.accounts ?? []) {
        const accountId = account.accountId ?? account.id;
        const item = node('div', undefined, 'ws-card');
        item.append(node('p', [account.provider, account.label ?? account.email ?? accountId, account.selected ? '✓' : ''].filter(Boolean).join(' · ')), actions(
          button(t('Выбрать', 'Select'), async () => { await raw('oauth-select', { provider: account.provider, accountId }); await refreshAccounts(); }),
          button(t('Отключить', 'Disconnect'), async () => { await raw('oauth-disconnect', { provider: account.provider, accountId }); await refreshAccounts(); }),
        )); accountList.append(item);
      }
      if (!accountList.children.length) accountList.append(node('p', t('Подключённых аккаунтов нет.', 'No accounts connected.')));
    };
    const connectOAuth = async provider => {
      const popup = window.open('about:blank', 'replylab-oauth', 'popup,width=650,height=750');
      try {
        const response = await raw('oauth-start', { provider });
        const url = new URL(response.url);
        const trusted = ['auth.openai.com', 'auth0.openai.com', 'accounts.openai.com', 'openrouter.ai'];
        if (url.protocol !== 'https:' || !trusted.includes(url.hostname)) throw new Error('Untrusted OAuth URL');
        if (popup) popup.location.replace(url.href);
        else throw new Error(t('Разрешите всплывающее окно и повторите подключение.', 'Allow the popup and try again.'));
        say(t('Завершите вход в новом окне, затем обновите список аккаунтов.', 'Complete sign-in in the new window, then refresh accounts.'));
      } catch (error) { popup?.close(); throw error; }
    };
    connections.append(node('p', t('Ключи и токены сохраняются сервером. Библиотека и её экспорт их не содержат.', 'Keys and tokens stay on the server and are not included in library exports.'), 'ws-muted'),
      actions(button('ChatGPT OAuth', () => connectOAuth('chatgpt')), button('OpenRouter OAuth', () => connectOAuth('openrouter')), button(t('Обновить аккаунты', 'Refresh accounts'), refreshAccounts)), accountList);
    const token = field(t('Токен моего сервера (не входит в экспорт)', 'My server token (excluded from export)'), '', { type: 'password', maxLength: 2000 });
    token.input.autocomplete = 'off';
    connections.append(token.wrapper, button(t('Сохранить токен сервера', 'Save server token'), async () => {
      await raw('server-credentials', { token: token.input.value }); token.input.value = '';
      say(t('Токен передан в защищённые настройки расширения.', 'Token saved in separate extension credentials.'));
    }));
    panel.append(connections);
    const memoryBox = card(t('Долговременная память', 'Long-term memory'));
    const memoryText = field(t('Новая запись', 'New memory'), '', { textarea: true, rows: 3, maxLength: 10000 });
    memoryBox.append(memoryText.wrapper, button(t('Добавить', 'Add'), () => mutate('save-memory', { memory: { text: memoryText.input.value, enabled: true } })));
    for (const item of live(state.memories)) {
      const value = field(t('Память', 'Memory'), item.text, { textarea: true, rows: 2, maxLength: 10000 });
      const enabled = field(t('Использовать', 'Use'), item.enabled, { type: 'checkbox' });
      const entry = node('div', undefined, 'ws-card'); entry.append(value.wrapper, enabled.wrapper, actions(
        button(t('Сохранить', 'Save'), () => mutate('save-memory', { memory: { ...item, text: value.input.value, enabled: enabled.input.checked } })),
        button(t('Удалить', 'Delete'), () => { if (confirm(t('Удалить запись памяти?', 'Delete this memory?'))) return mutate('delete-memory', { id: item.id }); }),
      )); memoryBox.append(entry);
    }
    panel.append(memoryBox);
  }
  try { await load(); } catch (error) { say(error.message, true); }
  return {
    refresh: load,
    async open(view, conversationId) {
      await flushNotes();
      if (conversationId) selectedConversation = conversationId;
      if (TABS.includes(view)) tab = view;
      await load();
      panel.scrollIntoView({ block: 'start', behavior: 'instant' });
    },
    async destroy() { assistantController?.abort(); await flushNotes(); attachments = []; app.remove(); },
  };
}
