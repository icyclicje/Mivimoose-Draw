// ─────────────────────────────────────────────────────────────
// dialog.js — in-app confirm/prompt boxes.
//
// window.confirm() and window.prompt() are unavailable inside a
// Discord Activity: the iframe is sandboxed without allow-modals,
// so confirm() returns false and prompt() returns null without
// showing anything. Every "are you sure?" in the game silently
// answered "no", which is why the Leave button did nothing there.
//
//   await MiviDialog.confirm('Leave the game?')      -> boolean
//   await MiviDialog.prompt('New name:', {value})    -> string | null
// ─────────────────────────────────────────────────────────────
(function () {
  'use strict';

  let root = null;
  let active = null;   // { resolve, kind }

  function build() {
    if (root) return root;
    root = document.createElement('div');
    root.className = 'modal-backdrop dialog-backdrop';
    root.style.display = 'none';
    root.innerHTML =
      '<div class="modal modal-sm dialog-card" role="dialog" aria-modal="true">' +
        '<h2 class="dialog-title"></h2>' +
        '<p class="dialog-message"></p>' +
        '<input type="text" class="input dialog-input" maxlength="120" style="display:none" />' +
        '<div class="dialog-actions">' +
          '<button class="btn btn-small btn-alt dialog-cancel"></button>' +
          '<button class="btn btn-small dialog-ok"></button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(root);

    root.querySelector('.dialog-cancel').addEventListener('click', () => finish(null));
    root.querySelector('.dialog-ok').addEventListener('click', () => finish(true));
    root.addEventListener('mousedown', (e) => { if (e.target === root) finish(null); });
    root.querySelector('.dialog-input').addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') finish(true);
      else if (e.key === 'Escape') finish(null);
    });
    document.addEventListener('keydown', (e) => {
      if (!active) return;
      if (e.key === 'Escape') { e.preventDefault(); finish(null); }
      else if (e.key === 'Enter' && active.kind === 'confirm') { e.preventDefault(); finish(true); }
    });
    return root;
  }

  // `ok` is true for the primary button, null for cancel/dismiss.
  function finish(ok) {
    if (!active) return;
    const { resolve, kind } = active;
    const input = root.querySelector('.dialog-input');
    const value = input.value;
    active = null;
    root.style.display = 'none';
    if (kind === 'confirm') resolve(ok === true);
    else resolve(ok === true ? value : null);
  }

  function open(kind, message, opts) {
    const o = opts || {};
    build();
    // A second dialog while one is open cancels the first rather than stacking.
    if (active) finish(null);

    root.querySelector('.dialog-title').textContent = o.title || (kind === 'confirm' ? 'Are you sure?' : 'Enter a value');
    root.querySelector('.dialog-message').textContent = message || '';
    const input = root.querySelector('.dialog-input');
    input.style.display = kind === 'prompt' ? 'block' : 'none';
    input.value = kind === 'prompt' ? (o.value || '') : '';
    input.placeholder = o.placeholder || '';

    const ok = root.querySelector('.dialog-ok');
    ok.textContent = o.confirmLabel || (kind === 'confirm' ? 'Yes' : 'OK');
    ok.classList.toggle('btn-danger-solid', !!o.danger);
    root.querySelector('.dialog-cancel').textContent = o.cancelLabel || 'Cancel';

    root.style.display = 'flex';
    return new Promise((resolve) => {
      active = { resolve, kind };
      setTimeout(() => {
        if (kind === 'prompt') { input.focus(); input.select(); }
        else ok.focus();
      }, 0);
    });
  }

  window.MiviDialog = {
    confirm: (message, opts) => open('confirm', message, opts),
    prompt: (message, opts) => open('prompt', message, opts),
  };
})();
