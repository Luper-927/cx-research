'use strict';
// Dialogs and toasts. Built on <dialog> so focus trapping and Esc come from the browser.
CX.ui = (function () {
  const { h } = CX.util;
  const T = (x) => x;
  function modal(build, cls) {
    return new Promise((resolve) => {
      const d = h('dialog', { class: 'dlg ' + (cls || '') });
      let done = false;
      const close = (v) => { if (done) return; done = true; try { d.close(); } catch (_) { /* closed */ } d.remove(); resolve(v); };
      d.addEventListener('cancel', (e) => { e.preventDefault(); close(null); });
      d.addEventListener('click', (e) => { if (e.target === d) close(null); });
      build(d, close);
      document.body.appendChild(d);
      d.showModal();
    });
  }
  function prompt(title, label, initial, o) {
    o = o || {};
    return modal((d, close) => {
      const input = h('input', { class: 'input', type: 'text', value: initial || '', autocomplete: 'off', autocapitalize: 'none', spellcheck: 'false', 'aria-label': T(label), 'aria-describedby': 'dlg-err' });
      const err = h('div', { id: 'dlg-err', class: 'muted', role: 'alert' });
      const ok = () => { const v = input.value; const bad = o.validate ? o.validate(v) : null; if (bad) { err.textContent = T(bad); input.focus(); return; } close(v); };
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); ok(); } });
      d.append(h('div', { class: 'dlg-body' }, h('h2', { class: 'title', text: T(title) }), h('label', { class: 'muted', text: T(label) }), input, err),
        h('div', { class: 'dlg-actions' }, h('button', { class: 'btn', onclick: () => close(null), text: 'Cancel' }), h('button', { class: 'btn primary', onclick: ok, text: o.okLabel || 'OK' })));
      setTimeout(() => { input.focus(); input.select(); }, 0);
    });
  }
  function confirm(title, message, o) {
    o = o || {};
    return modal((d, close) => {
      const body = h('div', { class: 'dlg-body' }, h('h2', { class: 'title', text: T(title) }), h('p', { class: 'muted', style: 'margin:0;overflow-wrap:anywhere', text: T(message) }));
      let typed = null, okBtn;
      if (o.typeToConfirm) {
        typed = h('input', { class: 'input', type: 'text', autocomplete: 'off', autocapitalize: 'none', spellcheck: 'false', 'aria-label': T('Type “' + o.typeToConfirm + '” to confirm') });
        typed.addEventListener('input', () => { okBtn.disabled = typed.value !== o.typeToConfirm; });
        body.append(h('label', { class: 'muted', text: T('Type “' + o.typeToConfirm + '” to confirm') }), typed);
      }
      okBtn = h('button', { class: 'btn ' + (o.danger ? 'danger' : 'primary'), onclick: () => close(true), text: o.okLabel || 'OK', disabled: !!o.typeToConfirm });
      d.append(body, h('div', { class: 'dlg-actions' }, h('button', { class: 'btn', onclick: () => close(false), text: o.cancelLabel || 'Cancel' }), okBtn));
      setTimeout(() => (typed || okBtn).focus(), 0);
    }).then((v) => v === true);
  }
  function notice(title, message, items) {
    return modal((d, close) => {
      const body = h('div', { class: 'dlg-body' }, h('h2', { class: 'title', text: T(title) }), h('p', { class: 'muted', style: 'margin:0;overflow-wrap:anywhere', text: T(message) }));
      if (items && items.length) body.append(h('ul', { class: 'issues' }, items.slice(0, 12).map((t) => h('li', { class: 'err', text: T(t) }))));
      d.append(body, h('div', { class: 'dlg-actions' }, h('button', { class: 'btn primary', onclick: () => close(true), text: 'Close' })));
    });
  }
  function toast(message, kind) {
    const box = document.getElementById('toasts');
    const t = h('div', { class: 'toast ' + (kind || ''), role: kind === 'err' ? 'alert' : 'status', text: T(message) });
    box.appendChild(t);
    setTimeout(() => t.remove(), kind === 'err' ? 9000 : 4200);
  }
  const msg = (e) => (e && e.message ? e.message : String(e));
  const fail = (e) => { console.error(e); toast(msg(e), 'err'); };
  return { modal, prompt, confirm, notice, toast, fail, msg };
})();
