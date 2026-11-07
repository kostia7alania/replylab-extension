import { findComposer, insertReply } from './page-adapter.js';

let stopCurrent = null;

function button(text, className = '') {
  const element = document.createElement('button');
  element.type = 'button';
  element.className = className;
  element.textContent = text;
  return element;
}

function createPanel(composer, schedule) {
  const host = document.createElement('aside');
  host.dataset.replylabHelper = '';
  host.setAttribute('aria-label', 'Помощник ReplyLab');
  const shadow = host.attachShadow({ mode: 'open', delegatesFocus: true });
  const stylesheet = document.createElement('link');
  stylesheet.rel = 'stylesheet';
  stylesheet.href = chrome.runtime.getURL('panel.css');
  shadow.append(stylesheet);
  const panel = document.createElement('section');
  panel.className = 'panel';
  panel.innerHTML = `
    <header><div><strong>ReplyLab</strong><span class="subtitle">Ваш черновик, ваше решение</span></div><button type="button" class="settings">Настроить ReplyLab</button></header>
    <label class="context-label">Контекст, если поле сообщения пустое<textarea class="context" rows="2" placeholder="Вставьте сюда текст, на который хотите ответить"></textarea></label>
    <div class="controls"><label>Тон<select class="tone"><option value="friendly" selected>Дружелюбный</option><option value="playful">Игривый</option><option value="concise">Краткий</option></select></label><button type="button" class="generate">Предложить ответы</button></div>
    <p class="status" role="status" aria-live="polite">Берём черновик, выделенный текст или контекст выше.</p>
    <div class="results"></div><div class="confirmation" hidden></div>
    <p class="footnote">Вставка не отправляет сообщение.</p>`;
  shadow.append(panel);
  const $ = selector => shadow.querySelector(selector);
  const status = $('.status');
  const results = $('.results');
  const confirmation = $('.confirmation');
  const generate = $('.generate');
  const route = location.href;
  let disposed = false;
  let requestNumber = 0;
  let pending = null;

  const notify = (text, error = false) => {
    status.textContent = text;
    status.classList.toggle('error', error);
  };
  const current = () => !disposed && host.isConnected && route === location.href
    && composer === findComposer(document, location);
  function clearPending() {
    pending = null;
    confirmation.hidden = true;
    confirmation.replaceChildren();
  }
  function insert(text) {
    if (!current()) { schedule(); return; }
    clearPending();
    if (!insertReply(composer, text)) { notify('Поле изменилось. Откройте диалог ещё раз.', true); schedule(); return; }
    notify('Вариант вставлен. Проверьте и отправьте его сами.');
  }
  function requestInsertion(text) {
    if (!current()) { schedule(); return; }
    clearPending();
    if (composer.value === text) { notify('Этот вариант уже в поле сообщения.'); return; }
    if (!composer.value.length) { insert(text); return; }
    pending = { text, draft: composer.value };
    const explanation = document.createElement('p');
    explanation.textContent = 'В поле уже есть черновик. Заменить его этим вариантом?';
    const accept = button('Заменить черновик', 'confirm');
    const cancel = button('Оставить черновик', 'secondary');
    accept.addEventListener('click', () => {
      if (!current()) { schedule(); return; }
      if (!pending || composer.value !== pending.draft) {
        clearPending();
        notify('Черновик изменился. Снова нажмите «Вставить».', true);
        return;
      }
      insert(pending.text);
    });
    cancel.addEventListener('click', clearPending);
    confirmation.append(explanation, accept, cancel);
    confirmation.hidden = false;
    notify('Черновик сохранён. Замена требует вашего подтверждения.');
  }
  function render(replies) {
    results.replaceChildren(...replies.map(reply => {
      const article = document.createElement('article');
      article.className = 'reply';
      const text = document.createElement('p');
      text.textContent = reply.text;
      const reason = document.createElement('small');
      reason.textContent = reply.reason;
      const actions = document.createElement('div');
      actions.className = 'actions';
      const add = button('Вставить', 'insert');
      add.addEventListener('click', () => requestInsertion(reply.text));
      const copy = button('Копировать', 'secondary');
      copy.addEventListener('click', async () => {
        try { await navigator.clipboard.writeText(reply.text); if (current()) notify('Вариант скопирован.'); }
        catch { if (current()) notify('Выделите текст варианта и скопируйте вручную.', true); }
      });
      actions.append(add, copy);
      article.append(text, reason, actions);
      return article;
    }));
  }
  generate.addEventListener('click', async (event) => {
    if (!event.isTrusted) return;
    if (!current()) { schedule(); return; }
    const selection = window.getSelection();
    const selected = selection?.anchorNode?.getRootNode() === document
      && selection?.focusNode?.getRootNode() === document ? selection.toString().trim() : '';
    const text = composer.value.trim() || selected || $('.context').value.trim();
    if (!text) { notify('Выделите сообщение или вставьте контекст выше.', true); $('.context').focus(); return; }
    if (text.length > 10000) { notify('Контекст длиннее 10 000 символов. Сократите его вручную.', true); return; }
    const number = ++requestNumber;
    clearPending();
    results.replaceChildren();
    generate.disabled = true;
    generate.textContent = 'Готовим…';
    notify('Готовим три варианта…');
    try {
      const response = await chrome.runtime.sendMessage({ type: 'replylab:suggest', text, tone: $('.tone').value });
      if (!current() || number !== requestNumber) { schedule(); return; }
      if (!response?.ok) throw new Error(response?.error || 'Не удалось получить варианты.');
      if (!Array.isArray(response.replies) || response.replies.length !== 3
        || response.replies.some(reply => typeof reply?.text !== 'string' || !reply.text.trim()
          || typeof reply.reason !== 'string' || !reply.reason.trim())) throw new Error('Получен некорректный ответ.');
      render(response.replies);
      notify('Выберите вариант. Черновик можно заменить только с подтверждением.');
    } catch (error) {
      if (current() && number === requestNumber) notify(error.message || 'Откройте настройки ReplyLab.', true);
    } finally {
      if (!disposed && number === requestNumber) {
        generate.disabled = false;
        generate.textContent = 'Предложить ответы';
      }
    }
  });
  $('.settings').addEventListener('click', async () => {
    try { await chrome.runtime.sendMessage({ type: 'replylab:open-options' }); }
    catch { notify('Откройте ReplyLab с панели расширений.', true); }
  });
  const anchor = composer.closest('form') ?? composer;
  anchor.insertAdjacentElement('afterend', host);
  return { host, composer, route, remove() { disposed = true; requestNumber++; clearPending(); host.remove(); } };
}

export function start() {
  if (stopCurrent) return stopCurrent;
  let mounted = null;
  let frame = 0;
  let stopped = false;
  function scan() {
    frame = 0;
    if (stopped) return;
    const composer = findComposer(document, location);
    if (mounted && (mounted.composer !== composer || mounted.route !== location.href || !mounted.host.isConnected)) {
      mounted.remove();
      mounted = null;
    }
    if (!mounted && composer) mounted = createPanel(composer, schedule);
  }
  function schedule() {
    if (!stopped && !frame) frame = requestAnimationFrame(scan);
  }
  const observer = new MutationObserver(schedule);
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['class', 'style', 'hidden', 'inert', 'disabled', 'readonly', 'aria-hidden', 'aria-disabled'],
  });
  const events = ['popstate', 'hashchange', 'pageshow', 'resize'];
  events.forEach(event => window.addEventListener(event, schedule));
  document.addEventListener('focusin', schedule);
  window.navigation?.addEventListener('currententrychange', schedule);
  stopCurrent = () => {
    if (stopped) return;
    stopped = true;
    observer.disconnect();
    cancelAnimationFrame(frame);
    mounted?.remove();
    events.forEach(event => window.removeEventListener(event, schedule));
    document.removeEventListener('focusin', schedule);
    window.navigation?.removeEventListener('currententrychange', schedule);
    stopCurrent = null;
  };
  schedule();
  return stopCurrent;
}
