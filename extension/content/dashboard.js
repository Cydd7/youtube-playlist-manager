/*
 * The dashboard: toolbars, status line and the folder tree, rendered in a
 * shadow root. main.js decides when and where it is shown.
 *
 * Every edit goes through change(): it snapshots the library for undo, edits
 * `this.doc` through PM.model, re-renders and schedules a save. The tree is
 * simply rebuilt from the document each time; selection and search are
 * applied while rebuilding.
 */
(() => {
  'use strict';

  const PM = (globalThis.PM ??= {});
  const { h, fill, icon, plural } = PM.dom;
  const M = PM.model;

  const SAVE_DELAY_MS = 300;
  const NOTICE_HIDE_MS = 8000;
  const SEARCH_DELAY_MS = 120;
  const MAX_DETAILS = 8;
  const MAX_UNDO = 50;
  // Marks this tab's own storage writes so it only reloads for other tabs' changes.
  const INSTANCE = `tab-${Math.random().toString(36).slice(2)}`;

  const describe = (stats) =>
    `${plural(stats.folders, 'folder')}, ${plural(stats.playlists, 'playlist')} and ${plural(stats.videos, 'video')}`;
  const isVideoKey = (key) => key.startsWith('v:');

  function dateStamp(date = new Date()) {
    const pad = (n) => String(n).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  }

  /** `text` with every search word wrapped in <mark>. */
  function highlight(text, words) {
    const lower = text.toLowerCase();
    if (!words.length || lower.length !== text.length) return [text];
    const ranges = [];
    for (const word of words) {
      for (let at = lower.indexOf(word); at !== -1; at = lower.indexOf(word, at + word.length)) ranges.push([at, at + word.length]);
    }
    ranges.sort((a, b) => a[0] - b[0]);
    const parts = [];
    let pos = 0;
    for (const [start, end] of ranges) {
      if (end <= pos) continue;
      if (start > pos) parts.push(text.slice(pos, start));
      parts.push(h('mark', null, text.slice(Math.max(start, pos), end)));
      pos = end;
    }
    if (pos < text.length) parts.push(text.slice(pos));
    return parts;
  }

  class Dashboard {
    constructor() {
      this.doc = M.emptyDoc();
      this.ui = { collapsed: false };
      this.loaded = false;
      this.loading = null;
      this.reloadAgain = false;
      this.editingId = null;
      this.namingNewFolder = null;
      this.status = null;
      this.statusTimer = null;
      this.busy = false;
      this.saveTimer = null;
      this.themeObserver = null;
      this.query = '';
      this.words = [];
      this.searchTimer = null;
      this.selection = new Set(); // row keys: "n:<folder or playlist ID>" or "v:<entry key>"
      this.anchor = null; // where a Shift-click range starts
      this.undoStack = [];
      this.redoStack = [];
      this.entryKeys = new WeakMap(); // playlist entry → stable key, so a selected video stays selected as it moves
      this.nextEntryKey = 1;
      this.rows = new Map(); // row key → what the row shows, for the current render
      this.order = []; // row keys in display order
      this.drag = null; // { el, key, keys } while rows are being dragged
      this.pending = { total: 0, byPlaylist: new Map() };
      this.host = this.build();
      PM.storage.watch(INSTANCE, () => this.reload());
      window.addEventListener('pagehide', () => this.flushSave());
    }

    // -------------------------------------------------------------------------
    // Setup

    build() {
      const host = h('div', { id: 'youtube-playlist-manager', style: { display: 'block', margin: '16px 0 24px' } });
      // Keys typed in the dashboard must not trigger YouTube's keyboard shortcuts.
      for (const type of ['keydown', 'keyup', 'keypress']) host.addEventListener(type, (e) => e.stopPropagation());
      const shadow = host.attachShadow({ mode: 'open' });

      const button = (label, iconName, title, onclick, ...extra) =>
        h('button', { class: 'pm-btn', type: 'button', title, onclick }, icon(iconName), label, ...extra);
      const iconButton = (iconName, label, onclick) =>
        h('button', { class: 'pm-icon-btn', type: 'button', title: label, 'aria-label': label, onclick }, icon(iconName));

      this.collapseBtn = h('button', {
        class: 'pm-icon-btn pm-collapse',
        type: 'button',
        title: 'Show or hide the folders',
        'aria-label': 'Show or hide the folders',
        onclick: () => this.setCollapsed(!this.ui.collapsed),
      }, icon('chevron'));
      this.summary = h('span', { class: 'pm-summary' });
      this.pushCount = h('span', { class: 'pm-count', hidden: true });

      this.buttons = {
        pull: button('Pull from YouTube', 'pull',
          'Bring in what changed on YouTube. Only playlists that changed are read; Shift-click to read everything again. ' +
          'Your folders and changes here are kept.',
          (event) => PM.syncUi.pull(this, { full: event.shiftKey })),
        push: button('Push to YouTube', 'push', 'Send the changes made here to your playlists on YouTube. You see them before anything changes.',
          () => PM.syncUi.push(this), this.pushCount),
        import: button('Import', 'import', 'Load a backup file', () => this.fileInput.click()),
        export: button('Export', 'export', 'Download everything as one JSON file', () => this.exportBackup()),
        folder: button('Folder', 'folderPlus', 'Add a folder at the top level', () => this.addFolder(M.ROOT)),
        undo: iconButton('undo', 'Undo (Ctrl+Z)', () => this.undo()),
        redo: iconButton('redo', 'Redo (Ctrl+Shift+Z)', () => this.redo()),
      };

      this.searchInput = h('input', {
        class: 'pm-search-input',
        type: 'search',
        placeholder: 'Search folders, playlists and videos',
        'aria-label': 'Search folders, playlists and videos',
        oninput: () => {
          clearTimeout(this.searchTimer);
          this.searchTimer = setTimeout(() => this.setQuery(this.searchInput.value), SEARCH_DELAY_MS);
        },
        onkeydown: (e) => {
          if (e.key === 'Escape' && this.searchInput.value) {
            e.preventDefault();
            this.setQuery('');
          }
        },
      });
      this.selectionBar = h('div', { class: 'pm-selection', hidden: true });
      this.fileInput = h('input', { type: 'file', accept: '.json,application/json', hidden: true, onchange: (e) => this.importFile(e.target) });
      this.statusEl = h('div', { class: 'pm-status', role: 'status', hidden: true });
      this.tree = h('div', { class: 'pm-tree', role: 'tree', tabindex: '0', 'aria-multiselectable': 'true', 'aria-label': 'Folders and playlists' });
      this.body = h('div', { class: 'pm-body' },
        h('div', { class: 'pm-tools' },
          h('div', { class: 'pm-search' }, icon('search'), this.searchInput),
          this.buttons.folder, this.buttons.undo, this.buttons.redo, this.selectionBar),
        this.tree);
      this.root = h('div', { class: 'pm' },
        h('div', { class: 'pm-bar' },
          h('div', { class: 'pm-heading' }, this.collapseBtn, h('h2', { class: 'pm-title' }, 'YouTube Playlist Manager'), this.summary),
          h('div', { class: 'pm-actions' }, this.buttons.pull, this.buttons.push, this.buttons.import, this.buttons.export)),
        this.statusEl,
        this.body,
        this.fileInput);

      shadow.append(h('style', null, PM.css), this.root);

      this.tree.addEventListener('click', (e) => this.onTreeClick(e));
      this.tree.addEventListener('dblclick', (e) => this.onTreeDblClick(e));
      this.root.addEventListener('keydown', (e) => this.onKeydown(e));
      PM.dnd.attach(this, this.tree);
      return host;
    }

    mount(anchor) {
      anchor.prepend(this.host);
      this.followTheme();
      if (this.loaded || this.loading) this.render();
      else this.reload();
    }

    unmount() {
      this.flushSave();
      this.host.remove();
      this.themeObserver?.disconnect();
      this.themeObserver = null;
    }

    /** YouTube marks dark mode with a `dark` attribute on <html>. */
    followTheme() {
      const apply = () => {
        this.root.dataset.theme = document.documentElement.hasAttribute('dark') ? 'dark' : 'light';
      };
      apply();
      if (!this.themeObserver) {
        this.themeObserver = new MutationObserver(apply);
        this.themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['dark'] });
      }
    }

    // -------------------------------------------------------------------------
    // Loading and saving

    reload() {
      if (this.loading) {
        this.reloadAgain = true;
        return this.loading;
      }
      this.loading = (async () => {
        try {
          const [doc, ui] = await Promise.all([PM.storage.loadDoc(), PM.storage.loadUi()]);
          const problems = M.validate(doc);
          if (problems.length) {
            this.doc = M.emptyDoc();
            this.setStatus('The saved library looks damaged, so the dashboard started empty. Import a backup to restore it.', 'error', problems);
          } else {
            // Libraries saved by older versions carry an older format name and version.
            this.doc = { ...doc, format: M.FORMAT, version: M.VERSION };
          }
          this.ui = { collapsed: false, ...ui };
          this.loaded = true;
          // Undo snapshots refer to the library as it was; it has just been replaced.
          this.undoStack = [];
          this.redoStack = [];
        } catch (err) {
          this.reportError(err);
        } finally {
          this.loading = null;
        }
        if (this.reloadAgain) {
          this.reloadAgain = false;
          return this.reload();
        }
        this.render();
      })();
      return this.loading;
    }

    /** Re-renders now and saves the structure shortly after (several quick edits share one save). */
    commit() {
      this.render();
      clearTimeout(this.saveTimer);
      this.saveTimer = setTimeout(() => this.flushSave(), SAVE_DELAY_MS);
    }

    async flushSave() {
      if (this.saveTimer == null) return;
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
      try {
        await PM.storage.saveStructure(this.doc, INSTANCE);
      } catch (err) {
        this.reportError(err);
      }
    }

    /** Replaces the whole stored library with `doc` (import). */
    async replaceDoc(doc) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
      this.doc = doc;
      this.editingId = null;
      this.selection.clear();
      this.undoStack = [];
      this.redoStack = [];
      this.render();
      await PM.storage.saveDoc(doc, INSTANCE);
    }

    setCollapsed(collapsed) {
      this.ui.collapsed = collapsed;
      this.render();
      PM.storage.saveUi(this.ui).catch((err) => this.reportError(err));
    }

    setBusy(busy) {
      this.busy = busy;
      this.render();
    }

    reportError(err) {
      console.error('[YouTube Playlist Manager]', err);
      const message = String(err?.message || err);
      if (/context invalidated/i.test(message)) {
        this.setStatus('YouTube Playlist Manager was updated or reloaded. Refresh this page to keep using it.', 'error');
      } else {
        this.setStatus(`Something went wrong: ${message}`, 'error');
      }
    }

    // -------------------------------------------------------------------------
    // Editing and undo

    /**
     * Makes an undoable edit: `edit` changes this.doc and returns whether it changed
     * anything. `notice` shows a message with an Undo button afterwards.
     */
    change(label, edit, notice) {
      const before = M.snapshot(this.doc);
      if (!edit()) {
        this.render();
        return false;
      }
      this.undoStack.push({ label, snapshot: before });
      if (this.undoStack.length > MAX_UNDO) this.undoStack.shift();
      this.redoStack = [];
      this.commit();
      if (notice) this.setStatus(notice, 'info', null, [{ label: 'Undo', onClick: () => this.undo() }]);
      return true;
    }

    undo() {
      this.stepHistory(this.undoStack, this.redoStack, 'Undone', { label: 'Redo', onClick: () => this.redo() });
    }

    redo() {
      this.stepHistory(this.redoStack, this.undoStack, 'Redone', { label: 'Undo', onClick: () => this.undo() });
    }

    stepHistory(from, to, verb, again) {
      if (this.busy || !from.length) return;
      const entry = from.pop();
      to.push({ label: entry.label, snapshot: M.snapshot(this.doc) });
      M.restore(this.doc, entry.snapshot);
      this.editingId = null;
      this.commit();
      this.setStatus(`${verb}: ${entry.label}.`, 'info', null, [again]);
    }

    // -------------------------------------------------------------------------
    // Status line

    /**
     * kind: 'info' | 'progress' | 'ask' | 'success' | 'error'. `details` is an optional
     * list of lines; `actions` an optional list of { label, onClick, primary } buttons.
     */
    setStatus(text, kind = 'info', details = null, actions = null) {
      clearTimeout(this.statusTimer);
      this.status = text ? { text, kind, details, actions } : null;
      if ((kind === 'success' || kind === 'info') && !details?.length) {
        this.statusTimer = setTimeout(() => this.setStatus(null), NOTICE_HIDE_MS);
      }
      this.renderStatus();
    }

    renderStatus() {
      const status = this.status;
      this.statusEl.hidden = !status;
      if (!status) {
        this.statusEl.replaceChildren();
        return;
      }
      this.statusEl.dataset.kind = status.kind;
      const details = status.details || [];
      const shown = details.slice(0, MAX_DETAILS);
      if (details.length > MAX_DETAILS) shown.push(`…and ${details.length - MAX_DETAILS} more.`);
      const actions = status.actions?.length
        ? h('div', { class: 'pm-status-actions' }, status.actions.map((action) => h('button', {
          class: `pm-btn${action.primary ? ' pm-btn--primary' : ''}`,
          type: 'button',
          onclick: action.onClick,
        }, action.label)))
        : null;
      fill(this.statusEl,
        h('div', { class: 'pm-status-text' },
          status.text,
          shown.length ? h('ul', null, shown.map((line) => h('li', null, line))) : null,
          actions),
        status.kind === 'progress' || status.kind === 'ask' ? null : h('button', {
          class: 'pm-icon-btn',
          type: 'button',
          title: 'Dismiss',
          'aria-label': 'Dismiss',
          onclick: () => this.setStatus(null),
        }, icon('close')));
    }

    // -------------------------------------------------------------------------
    // Rendering

    render() {
      if (!this.host.isConnected) return;
      this.pending = PM.sync.pending(this.doc);
      const search = this.loaded && this.words.length ? this.findMatches() : null;
      const stats = M.docStats(this.doc);
      if (!this.loaded) this.summary.textContent = '';
      else if (search) this.summary.textContent = `${search.count.toLocaleString()} ${search.count === 1 ? 'match' : 'matches'}`;
      else this.summary.textContent = `${plural(stats.folders, 'folder')} · ${plural(stats.playlists, 'playlist')} · ${plural(stats.videos, 'video')}`;

      this.collapseBtn.setAttribute('aria-expanded', String(!this.ui.collapsed));
      this.body.hidden = this.ui.collapsed;
      for (const name of ['pull', 'push', 'import', 'folder']) this.buttons[name].disabled = this.busy;
      this.buttons.undo.disabled = this.busy || !this.undoStack.length;
      this.buttons.redo.disabled = this.busy || !this.redoStack.length;
      this.buttons.undo.title = this.undoStack.length ? `Undo: ${this.undoStack.at(-1).label} (Ctrl+Z)` : 'Undo (Ctrl+Z)';
      this.buttons.redo.title = this.redoStack.length ? `Redo: ${this.redoStack.at(-1).label} (Ctrl+Shift+Z)` : 'Redo (Ctrl+Shift+Z)';
      this.pushCount.hidden = !this.pending.total;
      this.pushCount.textContent = this.pending.total.toLocaleString();
      this.tree.classList.toggle('pm-busy', this.busy);
      this.renderStatus();
      this.renderTree(search);
    }

    renderTree(search) {
      this.rows = new Map();
      this.order = [];
      if (!this.loaded) {
        this.tree.replaceChildren(h('div', { class: 'pm-empty' }, 'Loading…'));
      } else if (M.isEmpty(this.doc)) {
        this.tree.replaceChildren(h('div', { class: 'pm-empty' },
          h('strong', null, 'Nothing here yet'),
          'Pull your playlists from YouTube, import a backup, or start by adding folders.'));
      } else if (search && !search.nodes.size) {
        this.tree.replaceChildren(h('div', { class: 'pm-empty' }, `No matches for “${this.query}”.`));
      } else {
        const rows = [];
        this.addRows(rows, M.ROOT, 0, search);
        this.tree.replaceChildren(...rows);
      }
      // Selected rows that are no longer shown (moved away, filtered out, deleted) are let go.
      for (const key of this.selection) if (!this.rows.has(key)) this.selection.delete(key);
      this.renderSelectionBar();
      if (this.editingId) {
        const input = this.tree.querySelector('.pm-rename');
        if (input && this.root.getRootNode().activeElement !== input) {
          input.focus();
          input.select();
        }
      }
    }

    /**
     * Adds the rows inside `containerId`. While searching (`search` set), only
     * matches and what leads to them are shown; a match shows everything inside it.
     */
    addRows(rows, containerId, depth, search) {
      M.childrenOf(this.doc, containerId).forEach((id, index) => {
        let inner = search;
        if (search) {
          const match = search.nodes.get(id);
          if (!match) return;
          if (match === 'self') inner = null;
        }
        const folder = M.getFolder(this.doc, id);
        if (folder) {
          const open = inner ? true : folder.open;
          rows.push(this.addRow(`n:${id}`, { kind: 'folder', id }, () => this.folderRow(id, folder, containerId, index, depth, open)));
          if (!open) return;
          if (folder.children.length) this.addRows(rows, id, depth + 1, inner);
          else rows.push(this.emptyRow(id, depth + 1, 'Empty folder. Drag folders or playlists here.'));
          return;
        }
        const playlist = M.getPlaylist(this.doc, id);
        if (!playlist) return;
        const only = inner ? search.items.get(id) : null; // just the matching videos
        const open = only ? true : playlist.open;
        rows.push(this.addRow(`n:${id}`, { kind: 'playlist', id }, () => this.playlistRow(id, playlist, containerId, index, depth, open)));
        if (!open) return;
        if (!playlist.items.length) {
          rows.push(this.emptyRow(id, depth + 1, M.isReadOnly(playlist) ? 'No liked videos.' : 'No videos. Drag videos here.'));
        }
        playlist.items.forEach((item, i) => {
          if (only && !only.has(i)) return;
          const key = `v:${this.entryKey(item)}`;
          rows.push(this.addRow(key, { kind: 'video', playlist: id, index: i }, () => this.videoRow(id, playlist, item, i, depth + 1)));
        });
      });
    }

    /** Registers a row. While a row is being dragged its element is kept: replacing it would detach the element the browser is dragging. */
    addRow(key, info, create) {
      const row = this.drag?.key === key ? this.drag.el : create();
      const selected = this.selection.has(key);
      row.dataset.key = key;
      row.classList.toggle('pm-selected', selected);
      row.classList.toggle('pm-dragging', Boolean(this.drag?.keys.has(key)));
      row.setAttribute('aria-selected', String(selected));
      this.rows.set(key, info);
      this.order.push(key);
      return row;
    }

    entryKey(item) {
      let key = this.entryKeys.get(item);
      if (!key) {
        key = String(this.nextEntryKey++);
        this.entryKeys.set(item, key);
      }
      return key;
    }

    /** What matches the search: folders and playlists ('self' or 'inside') and matching video indexes per playlist. */
    findMatches() {
      const result = { nodes: new Map(), items: new Map(), count: 0 };
      const matches = (text) => {
        const lower = (text || '').toLowerCase();
        return this.words.every((word) => lower.includes(word));
      };
      const visit = (id) => {
        const folder = M.getFolder(this.doc, id);
        if (folder) {
          let inside = false;
          for (const child of folder.children) inside = visit(child) || inside;
          const self = matches(folder.name);
          if (self) result.count++;
          if (self || inside) result.nodes.set(id, self ? 'self' : 'inside');
          return self || inside;
        }
        const playlist = M.getPlaylist(this.doc, id);
        if (!playlist) return false;
        const found = new Set();
        playlist.items.forEach((item, i) => {
          const info = M.videoInfo(this.doc, item.videoId);
          if (matches(`${info.title} ${info.channel}`)) found.add(i);
        });
        const self = matches(playlist.title);
        result.count += found.size + (self ? 1 : 0);
        if (found.size) result.items.set(id, found);
        if (self || found.size) result.nodes.set(id, self ? 'self' : 'inside');
        return self || found.size > 0;
      };
      this.doc.root.forEach(visit);
      return result;
    }

    setQuery(value) {
      clearTimeout(this.searchTimer);
      this.searchInput.value = value;
      this.query = value.trim();
      this.words = this.query.toLowerCase().split(/\s+/).filter(Boolean);
      this.render();
    }

    folderRow(id, folder, parent, index, depth, open) {
      const editing = this.editingId === id;
      const stats = M.folderStats(this.doc, id);
      const meta = stats.folders || stats.playlists
        ? `${plural(stats.playlists, 'playlist')} · ${plural(stats.videos, 'video')}`
        : 'Empty';
      return h('div', {
        class: 'pm-row pm-row--folder',
        role: 'treeitem',
        'aria-level': depth + 1,
        'aria-expanded': String(open),
        draggable: editing ? 'false' : 'true',
        style: { '--depth': depth },
        dataset: { kind: 'folder', id, parent, index, open: String(open), label: folder.name },
      },
        this.twisty(open, folder.name),
        icon('folder', 'pm-icon pm-kind'),
        editing ? this.renameInput(id, folder.name) : h('span', { class: 'pm-name', title: folder.name }, highlight(folder.name, this.words)),
        editing ? null : h('span', { class: 'pm-meta' }, meta),
        h('span', { class: 'pm-spacer' }),
        editing ? null : h('span', { class: 'pm-row-actions' },
          this.actionButton('add-folder', 'folderPlus', `New folder inside “${folder.name}”`),
          this.actionButton('rename', 'pencil', `Rename “${folder.name}”`),
          this.actionButton('delete', 'trash', `Delete “${folder.name}”`, 'pm-danger')));
    }

    playlistRow(id, playlist, parent, index, depth, open) {
      const liked = M.isReadOnly(playlist);
      const privacy = playlist.youtube?.status?.privacyStatus;
      const waiting = this.pending.byPlaylist.get(id);
      return h('div', {
        class: `pm-row pm-row--playlist${liked ? ' pm-row--liked' : ''}`,
        role: 'treeitem',
        'aria-level': depth + 1,
        'aria-expanded': String(open),
        draggable: 'true',
        title: liked ? 'Liked videos mirrors YouTube and is read-only here. Drag videos out of it to copy them into your playlists.' : null,
        style: { '--depth': depth },
        dataset: { kind: 'playlist', id, parent, index, open: String(open), label: playlist.title },
      },
        this.twisty(open, playlist.title),
        icon(liked ? 'heart' : 'playlist', 'pm-icon pm-kind'),
        h('span', { class: 'pm-name', title: playlist.title }, highlight(playlist.title, this.words)),
        h('span', { class: 'pm-meta' }, plural(playlist.items.length, 'video')),
        privacy && privacy !== 'public' ? h('span', { class: 'pm-badge' }, privacy) : null,
        waiting ? h('span', {
          class: 'pm-badge pm-badge--pending',
          title: 'Changes made here that are not on YouTube yet. Push to YouTube to send them.',
        }, `${waiting.toLocaleString()} to push`) : null,
        h('span', { class: 'pm-spacer' }),
        h('span', { class: 'pm-row-actions' },
          this.link(liked ? 'https://www.youtube.com/playlist?list=LL' : `https://www.youtube.com/playlist?list=${encodeURIComponent(id)}`,
            'Open on YouTube', 'pm-icon-btn', icon('external'))));
    }

    videoRow(playlistId, playlist, item, index, depth) {
      const info = M.videoInfo(this.doc, item.videoId);
      const details = [info.channel && highlight(info.channel, this.words), info.duration, info.unavailable && 'Unavailable']
        .filter(Boolean)
        .flatMap((part, i) => (i ? [' · ', part] : [part]));
      const thumb = info.unavailable
        ? h('span', { class: 'pm-thumb' })
        : h('img', {
          class: 'pm-thumb',
          src: `https://i.ytimg.com/vi/${encodeURIComponent(item.videoId)}/mqdefault.jpg`,
          alt: '',
          loading: 'lazy',
          draggable: 'false',
        });
      return h('div', {
        class: `pm-row pm-row--video${info.unavailable ? ' pm-row--unavailable' : ''}`,
        role: 'treeitem',
        'aria-level': depth + 1,
        draggable: 'true',
        title: M.isReadOnly(playlist) ? 'Drag to copy this video into one of your playlists' : null,
        style: { '--depth': depth },
        dataset: { kind: 'video', playlist: playlistId, index, label: info.title },
      },
        h('span', { class: 'pm-index' }, index + 1),
        thumb,
        h('span', { class: 'pm-video-text' },
          this.link(`https://www.youtube.com/watch?v=${encodeURIComponent(item.videoId)}`, info.title, 'pm-link', highlight(info.title, this.words)),
          details.length ? h('span', { class: 'pm-sub' }, details) : null));
    }

    emptyRow(containerId, depth, text) {
      return h('div', {
        class: 'pm-row pm-row--empty',
        role: 'none',
        style: { '--depth': depth },
        dataset: { kind: 'empty', container: containerId },
      }, text);
    }

    twisty(open, name) {
      return h('button', {
        class: 'pm-twisty',
        type: 'button',
        'aria-label': `${open ? 'Close' : 'Open'} “${name}”`,
        dataset: { action: 'toggle' },
      }, icon('chevron'));
    }

    actionButton(action, iconName, label, extraClass = '') {
      return h('button', {
        class: `pm-icon-btn ${extraClass}`.trim(),
        type: 'button',
        title: label,
        'aria-label': label,
        dataset: { action },
      }, icon(iconName));
    }

    link(href, label, className, content) {
      return h('a', { class: className, href, title: label, 'aria-label': label, draggable: 'false' }, content);
    }

    renameInput(id, name) {
      const input = h('input', { class: 'pm-rename', type: 'text', value: name, maxlength: '200', 'aria-label': 'Folder name' });
      let finished = false;
      const finish = (save) => {
        if (finished) return;
        finished = true;
        this.editingId = null;
        const naming = this.namingNewFolder === id;
        this.namingNewFolder = null;
        if (!save) {
          this.render();
        } else if (naming) {
          // Naming a folder just added is part of adding it: one undo removes both.
          if (M.renameFolder(this.doc, id, input.value)) this.commit();
          else this.render();
        } else {
          this.change('Rename folder', () => M.renameFolder(this.doc, id, input.value));
        }
      };
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          finish(true);
        } else if (e.key === 'Escape') {
          e.preventDefault();
          finish(false);
        }
      });
      input.addEventListener('blur', () => finish(true));
      return input;
    }

    // -------------------------------------------------------------------------
    // Selection

    select(key, { add = false, range = false } = {}) {
      const videos = isVideoKey(key);
      const sameKind = (k) => isVideoKey(k) === videos;
      if (range && this.anchor && this.rows.has(this.anchor) && sameKind(this.anchor)) {
        const [from, to] = [this.order.indexOf(this.anchor), this.order.indexOf(key)].sort((a, b) => a - b);
        this.selection = new Set(this.order.slice(from, to + 1).filter(sameKind));
      } else if (add) {
        // Videos and folders/playlists are never selected together.
        if ([...this.selection].some((k) => !sameKind(k))) this.selection.clear();
        if (this.selection.has(key)) this.selection.delete(key);
        else this.selection.add(key);
        this.anchor = key;
      } else {
        this.selection = new Set([key]);
        this.anchor = key;
      }
      this.renderSelection();
    }

    clearSelection() {
      this.selection.clear();
      this.anchor = null;
      this.renderSelection();
    }

    /** Updates the selected look without rebuilding the tree. */
    renderSelection() {
      for (const row of this.tree.querySelectorAll('.pm-row[data-key]')) {
        const selected = this.selection.has(row.dataset.key);
        row.classList.toggle('pm-selected', selected);
        row.setAttribute('aria-selected', String(selected));
      }
      this.renderSelectionBar();
    }

    /** The selected rows in display order, as { key, info }. */
    selected() {
      return this.order.filter((key) => this.selection.has(key)).map((key) => ({ key, info: this.rows.get(key) }));
    }

    renderSelectionBar() {
      const picked = this.selected();
      this.selectionBar.hidden = !picked.length;
      if (!picked.length) {
        this.selectionBar.replaceChildren();
        return;
      }
      const videos = picked.filter((p) => p.info.kind === 'video');
      const folders = picked.filter((p) => p.info.kind === 'folder');
      let action = null;
      if (videos.length) {
        const liked = videos.some((p) => M.isReadOnly(this.doc.playlists[p.info.playlist]));
        action = h('button', {
          class: 'pm-btn pm-btn--danger',
          type: 'button',
          disabled: liked || this.busy,
          title: liked ? "Videos in Liked videos can't be removed here" : 'Remove from their playlists (Delete)',
          onclick: () => this.deleteSelection(),
        }, icon('trash'), 'Remove from playlist');
      } else if (folders.length === picked.length) {
        action = h('button', {
          class: 'pm-btn pm-btn--danger',
          type: 'button',
          disabled: this.busy,
          title: 'Delete (Delete). What is inside moves up a level.',
          onclick: () => this.deleteSelection(),
        }, icon('trash'), folders.length === 1 ? 'Delete folder' : 'Delete folders');
      }
      fill(this.selectionBar,
        h('span', { class: 'pm-selection-count' }, `${plural(picked.length, videos.length ? 'video' : 'item')} selected`),
        action,
        h('button', { class: 'pm-icon-btn', type: 'button', title: 'Clear selection (Esc)', 'aria-label': 'Clear selection', onclick: () => this.clearSelection() }, icon('close')));
    }

    deleteSelection() {
      if (this.busy) return;
      const picked = this.selected();
      const videos = picked.filter((p) => p.info.kind === 'video');
      const folders = picked.filter((p) => p.info.kind === 'folder');
      if (videos.length) {
        if (videos.some((p) => M.isReadOnly(this.doc.playlists[p.info.playlist]))) {
          this.setStatus("Videos in Liked videos can't be removed here. Unlike them on YouTube instead.", 'info');
          return;
        }
        const refs = videos.map((p) => ({ playlist: p.info.playlist, index: p.info.index }));
        const label = `Remove ${plural(refs.length, 'video')}`;
        this.selection.clear();
        this.change(label, () => M.removeVideos(this.doc, refs) > 0, `Removed ${plural(refs.length, 'video')}.`);
      } else if (folders.length && folders.length === picked.length) {
        const ids = folders.map((p) => p.info.id);
        this.selection.clear();
        const label = ids.length === 1 ? 'Delete folder' : `Delete ${ids.length} folders`;
        this.change(label, () => M.deleteFolders(this.doc, ids) > 0,
          `Deleted ${plural(ids.length, 'folder')}. ${ids.length === 1 ? 'Its contents' : 'Their contents'} moved up a level.`);
      }
    }

    // -------------------------------------------------------------------------
    // Tree interactions

    onTreeClick(e) {
      if (e.target.closest('a, input')) return;
      const row = e.target.closest('.pm-row');
      if (!row) {
        if (!e.ctrlKey && !e.metaKey && !e.shiftKey) this.clearSelection();
        return;
      }
      const { kind, id, key } = row.dataset;
      if (kind === 'empty') return;
      const action = e.target.closest('[data-action]')?.dataset.action;
      if (action === 'add-folder') return this.addFolder(id);
      if (action === 'rename') return this.startRename(id);
      if (action === 'delete') return this.deleteFolder(id);
      if (action === 'toggle') return this.toggle(id);
      if (e.shiftKey) return this.select(key, { range: true });
      if (e.ctrlKey || e.metaKey) return this.select(key, { add: true });
      if (e.detail > 1) return; // the second click of a double-click
      this.select(key);
      if (kind === 'folder' || kind === 'playlist') this.toggle(id);
    }

    /** Double-clicking a folder's name renames it (and undoes the toggle from the first click). */
    onTreeDblClick(e) {
      const row = e.target.closest('.pm-row--folder');
      if (!row || !e.target.closest('.pm-name')) return;
      M.setOpen(this.doc, row.dataset.id);
      this.editingId = row.dataset.id;
      this.commit();
    }

    onKeydown(e) {
      const typing = Boolean(e.target.closest?.('input'));
      const mod = e.ctrlKey || e.metaKey;
      const key = e.key.toLowerCase();
      if (mod && !e.altKey && !typing && (key === 'z' || key === 'y')) {
        e.preventDefault();
        if (key === 'y' || e.shiftKey) this.redo();
        else this.undo();
      } else if (!typing && e.key === 'Escape' && this.selection.size) {
        e.preventDefault();
        this.clearSelection();
      } else if (!typing && (e.key === 'Delete' || e.key === 'Backspace') && this.selection.size) {
        e.preventDefault();
        this.deleteSelection();
      }
    }

    /** Opening and closing is how you look at the library, so it isn't an undo step. */
    toggle(id) {
      if (M.setOpen(this.doc, id) !== null) this.commit();
    }

    addFolder(parentId) {
      this.change('Add folder', () => {
        this.editingId = M.addFolder(this.doc, parentId);
        this.namingNewFolder = this.editingId;
        return true;
      });
    }

    startRename(id) {
      if (!M.isFolder(this.doc, id)) return;
      this.editingId = id;
      this.render();
    }

    deleteFolder(id) {
      const folder = M.getFolder(this.doc, id);
      if (!folder) return;
      const count = folder.children.length;
      const parent = M.parentOf(this.doc, id);
      const destination = parent === M.ROOT ? 'the top level' : `“${this.doc.folders[parent].name}”`;
      this.change('Delete folder', () => Boolean(M.deleteFolder(this.doc, id)),
        count ? `Deleted “${folder.name}”. The ${plural(count, 'item')} inside moved to ${destination}.` : `Deleted “${folder.name}”.`);
    }

    // Drag and drop (called by PM.dnd) ------------------------------------------

    /** Starts dragging `row`, along with the other selected rows if it is selected. */
    beginDrag(row) {
      const key = row.dataset.key;
      if (!key || !this.rows.has(key)) return null;
      if (!this.selection.has(key)) this.select(key);
      const keys = this.order.filter((k) => this.selection.has(k));
      const infos = keys.map((k) => this.rows.get(k));
      this.drag = { el: row, key, keys: new Set(keys) };
      // Dim the rows only after the browser has captured the drag image.
      requestAnimationFrame(() => {
        if (this.drag?.el !== row) return;
        for (const r of this.tree.querySelectorAll('.pm-row[data-key]')) if (this.drag.keys.has(r.dataset.key)) r.classList.add('pm-dragging');
      });
      if (isVideoKey(key)) {
        return {
          kind: 'video',
          items: infos.map((info) => ({ playlist: info.playlist, index: info.index })),
          fromReadOnly: infos.some((info) => M.isReadOnly(this.doc.playlists[info.playlist])),
        };
      }
      return { kind: 'node', ids: infos.map((info) => info.id) };
    }

    endDrag() {
      this.drag = null;
      for (const row of this.tree.querySelectorAll('.pm-dragging')) row.classList.remove('pm-dragging');
    }

    openWhileDragging(id) {
      if (M.setOpen(this.doc, id, true) !== null) this.commit();
    }

    applyDrop(drag, result, { copy = false } = {}) {
      if (result.type === 'node') {
        const label = drag.ids.length === 1 ? `Move ${M.isFolder(this.doc, drag.ids[0]) ? 'folder' : 'playlist'}` : `Move ${drag.ids.length} items`;
        this.change(label, () => {
          const moved = M.moveNodes(this.doc, drag.ids, result.parent, result.index);
          if (moved && result.parent !== M.ROOT) M.setOpen(this.doc, result.parent, true);
          return moved;
        });
        return;
      }
      const copying = copy || drag.fromReadOnly;
      this.change(`${copying ? 'Copy' : 'Move'} ${plural(drag.items.length, 'video')}`, () => {
        const moved = M.moveVideos(this.doc, drag.items, result.playlist, result.index, { copy });
        if (moved) M.setOpen(this.doc, result.playlist, true);
        return moved;
      });
    }

    // -------------------------------------------------------------------------
    // Import and export

    exportBackup() {
      const json = JSON.stringify(M.toBackup(this.doc), null, 2);
      const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
      const link = h('a', { href: url, download: `youtube-playlist-manager-backup-${dateStamp()}.json`, hidden: true });
      this.root.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
      this.setStatus(`Exported ${describe(M.docStats(this.doc))}.`, 'success');
    }

    async importFile(input) {
      const file = input.files?.[0];
      input.value = ''; // lets the same file be chosen again later
      if (!file) return;

      let doc;
      try {
        doc = M.parseBackup(await file.text());
      } catch (err) {
        const problems = err.problems || [err.message];
        if (problems.length === 1) this.setStatus(`Couldn't import “${file.name}”: ${problems[0]}`, 'error');
        else this.setStatus(`Couldn't import “${file.name}” because of these problems:`, 'error', problems);
        return;
      }

      const incoming = M.docStats(doc);
      if (!M.isEmpty(this.doc)) {
        const question = `Replace your current library (${describe(M.docStats(this.doc))}) ` +
          `with “${file.name}” (${describe(incoming)})?\n\nExport first if you want to keep the current one.`;
        if (!window.confirm(question)) return;
      }
      try {
        await this.replaceDoc(doc);
        this.setStatus(`Imported ${describe(incoming)}.`, 'success');
      } catch (err) {
        this.reportError(err);
      }
    }
  }

  PM.Dashboard = Dashboard;
})();
