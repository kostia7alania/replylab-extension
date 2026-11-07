function editable(composer) {
  const view = composer?.ownerDocument?.defaultView;
  return Boolean(view && (composer instanceof view.HTMLTextAreaElement || composer instanceof view.HTMLElement && composer.isContentEditable)
    && composer.isConnected && !composer.disabled && !composer.readOnly
    && composer.getAttribute('aria-disabled') !== 'true');
}

export function findComposer(doc = document, loc = location) {
  const whatsapp = loc?.hostname === 'web.whatsapp.com';
  if (!whatsapp && !/^\/app\/messages(?:\/|$)/.test(loc?.pathname ?? '')) return null;
  if (!whatsapp && loc?.hostname && loc.hostname !== 'tinder.com' && !loc.hostname.endsWith('.tinder.com')) return null;
  const selector = whatsapp ? '#main footer [contenteditable="true"][role="textbox"], #main footer textarea' : 'textarea';
  const candidates = [...doc.querySelectorAll(selector)].filter(composer => {
    if (whatsapp && !composer.closest('#main')) return false;
    if (!editable(composer) || !whatsapp && !composer.closest('main, [role="main"], form')) return false;
    if (composer.closest('[hidden], [inert], [aria-hidden="true"], [role="search"], dialog, [role="dialog"], [aria-modal="true"], [data-replylab-helper]')) return false;
    if (composer.getAttribute('role') === 'searchbox') return false;
    const description = ['name', 'id', 'aria-label', 'placeholder'].map(name => composer.getAttribute(name) ?? '').join(' ');
    if (/search|поиск|искать/i.test(description)) return false;
    const style = doc.defaultView.getComputedStyle(composer);
    const box = composer.getBoundingClientRect();
    return style.display !== 'none' && style.visibility !== 'hidden' && style.visibility !== 'collapse'
      && composer.getClientRects().length > 0 && box.width > 0 && box.height > 0;
  });
  return candidates.length === 1 ? candidates[0] : null;
}

export function insertReply(composer, text) {
  if (!editable(composer) || typeof text !== 'string' || !text.trim() || text.length > 10000) return false;
  const view = composer.ownerDocument.defaultView;
  composer.focus({ preventScroll: true });
  if (composer instanceof view.HTMLTextAreaElement) {
    const setter = Object.getOwnPropertyDescriptor(view.HTMLTextAreaElement.prototype, 'value')?.set;
    if (!setter) return false;
    setter.call(composer, text);
  } else {
    composer.replaceChildren(composer.ownerDocument.createTextNode(text));
  }
  composer.dispatchEvent(new view.Event('input', { bubbles: true, composed: true }));
  if (typeof composer.setSelectionRange === 'function') composer.setSelectionRange(text.length, text.length);
  return true;
}

export function draftText(composer) {
  return typeof composer?.value === 'string' ? composer.value : composer?.textContent ?? '';
}

export function findSendButton(composer) {
  const root = composer?.closest('form, footer');
  if (!root) return null;
  const candidates = [...root.querySelectorAll('button[type="submit"], button[aria-label="Send"], button[aria-label="Отправить"], [role="button"][data-testid="send"]')]
    .filter(button => !button.disabled && button.getAttribute('aria-disabled') !== 'true' && button.getClientRects().length);
  return candidates.length === 1 ? candidates[0] : null;
}

export function findProfileAnchor(doc = document, loc = location) {
  if (loc.hostname !== 'tinder.com' && !loc.hostname.endsWith('.tinder.com') || !/^\/app\/recs(?:\/|$)/.test(loc.pathname)) return null;
  const candidates = [...doc.querySelectorAll('div.recsCardboard__cardsContainer, div:has(div.recsToolbar) div.Expand.profileContent')]
    .filter(element => element.getClientRects().length);
  return candidates.length === 1 ? candidates[0] : null;
}
