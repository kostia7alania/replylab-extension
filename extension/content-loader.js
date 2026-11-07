import(chrome.runtime.getURL('content.js')).then((module) => module.start()).catch(() => {
  console.warn('ReplyLab: обновите вкладку после обновления расширения.');
});
