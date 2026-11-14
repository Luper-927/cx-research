'use strict';
(async function start() {
  const root = document.getElementById('desktop');
  function fatal(title, e) {
    console.error(e);
    root.textContent = '';
    root.append(CX.util.h('div', { class: 'card', role: 'alert', style: 'margin:16px;max-width:560px' }, CX.util.h('h3', { text: title }),
      CX.util.h('p', { class: 'muted', text: (e && e.message) || String(e) }), CX.util.h('p', { class: 'muted', text: 'Nothing was deleted. If this keeps happening, your stored data may need to be restored from an exported backup.' })));
    const c = document.getElementById('chip-store'); c.firstChild.className = 'dot err'; c.lastChild.textContent = 'Startup error';
  }
  window.addEventListener('unhandledrejection', (e) => { console.error(e.reason); if (CX.ui) CX.ui.toast('Unexpected error: ' + CX.ui.msg(e.reason), 'err'); });
  window.addEventListener('error', (e) => { console.error(e.error || e.message); });
  try {
    const recovery = await CX.store.init();
    await CX.shell.init(recovery);
    document.documentElement.dataset.cxReady = '1';
    const lg = CX.legacy.detectLocal();
    if (lg && !(await CX.legacy.alreadyImported(lg.raw))) CX.ui.toast('CX Web v0.9 data was found in this browser. Open Workspaces to import it. Nothing has been changed.', 'info');
  } catch (e) { fatal('CX could not start', e); }
})();
