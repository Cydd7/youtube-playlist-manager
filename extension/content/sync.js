/*
 * The Pull from YouTube and Push to YouTube buttons. The background worker
 * talks to YouTube; this file starts a sync, shows its progress, and turns its
 * questions (like "Push 5 changes?") into buttons in the status line.
 */
(() => {
  'use strict';

  const PM = (globalThis.PM ??= {});

  const KEEPALIVE_MS = 20000;

  let running = false;

  /** `full`: read everything from YouTube again, not just the playlists that changed. */
  async function run(app, mode, { full = false } = {}) {
    if (running) return;
    running = true;
    app.setBusy(true);
    app.setStatus(mode === 'push' ? 'Checking YouTube before pushing…' : full ? 'Reading everything from YouTube…' : 'Checking YouTube for changes…', 'progress');
    await app.flushSave(); // the worker reads the library from storage

    let port = null;
    let keepalive = null;
    let finished = false;
    const finish = () => {
      finished = true;
      running = false;
      clearInterval(keepalive);
      app.setBusy(false);
      try {
        port?.disconnect();
      } catch {
        // Already disconnected.
      }
    };
    const post = (message) => {
      try {
        port.postMessage(message);
      } catch {
        // The worker went away; onDisconnect reports it.
      }
    };

    try {
      port = chrome.runtime.connect({ name: 'pm-sync' });
    } catch (err) {
      finish();
      app.reportError(err);
      return;
    }
    // Any message keeps the worker alive, including while a question waits for an answer.
    keepalive = setInterval(() => post({ type: 'ping' }), KEEPALIVE_MS);

    const reply = (type) => {
      app.setStatus(type === 'apply' ? 'Working…' : 'Cancelling…', 'progress');
      post({ type });
    };
    port.onMessage.addListener((message) => {
      if (message.type === 'progress') {
        app.setStatus(message.text, 'progress');
      } else if (message.type === 'ask') {
        app.setStatus(message.text, 'ask', message.details, [
          { label: message.confirm, primary: true, onClick: () => reply('apply') },
          { label: 'Cancel', onClick: () => reply('cancel') },
        ]);
      } else if (message.type === 'done' || message.type === 'error') {
        finish();
        app.setStatus(message.text, message.kind || (message.type === 'error' ? 'error' : 'success'), message.details);
      }
    });
    port.onDisconnect.addListener(() => {
      if (finished) return;
      finish();
      app.setStatus('The sync stopped unexpectedly. Try again.', 'error');
    });
    post({ type: mode, full });
  }

  PM.syncUi = {
    pull: (app, options) => run(app, 'pull', options),
    push: (app) => run(app, 'push'),
  };
})();
