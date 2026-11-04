/*
 * YouTube Playlist Manager data model.
 *
 * The whole library is one JSON document:
 *
 *   root       IDs of the top-level folders and playlists, in display order
 *   folders    { [folderId]:   { name, open, children: [folderId | playlistId] } }
 *   playlists  { [playlistId]: { title, open, items: [{ videoId, addedAt, itemId }], youtube, synced, syncedVersion, kind } }
 *   videos     { [videoId]:    video data exactly as the YouTube Data API returned it }
 *   sync       { channelId, channelTitle, pulledAt, pushedAt }   (after the first pull)
 *
 * For syncing, a playlist entry's `itemId` is its ID on YouTube, a playlist's
 * `synced` lists the YouTube entry IDs it had at the last pull or push, and
 * `syncedVersion` is YouTube's version tag for the playlist then (see sync.js).
 * `kind: 'liked'` marks the read-only Liked videos list.
 *
 * Rules: a folder holds folders and playlists, a playlist holds videos, and
 * every folder and playlist sits in exactly one place. A video's details are
 * stored once even when it is in several playlists. Entry objects are never
 * changed in place by edits (they are only moved, copied or removed), which is
 * what lets undo snapshots share them.
 *
 * Everything here is plain data manipulation (no DOM, no chrome.* APIs) so the
 * same file runs in the content script, the service worker and Node tests.
 */
(() => {
  'use strict';

  const PM = (globalThis.PM ??= {});

  const FORMAT = 'youtube-playlist-manager';
  // Backups made before the app was renamed say "playlist-manager"; the format is the same.
  const LEGACY_FORMATS = ['playlist-manager'];
  const VERSION = 2;
  const ROOT = 'root';
  const LIKED = 'liked';
  const MAX_PROBLEMS = 50;

  const hasOwn = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);
  const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

  function emptyDoc() {
    return { format: FORMAT, version: VERSION, root: [], folders: {}, playlists: {}, videos: {} };
  }

  const isFolder = (doc, id) => hasOwn(doc.folders, id);
  const isPlaylist = (doc, id) => hasOwn(doc.playlists, id);
  const getFolder = (doc, id) => (isFolder(doc, id) ? doc.folders[id] : null);
  const getPlaylist = (doc, id) => (isPlaylist(doc, id) ? doc.playlists[id] : null);
  const getVideo = (doc, id) => (hasOwn(doc.videos, id) ? doc.videos[id] : null);
  /** Liked videos mirrors YouTube and can't be edited here; videos dragged out of it are copied. */
  const isReadOnly = (playlist) => playlist?.kind === LIKED;

  function isEmpty(doc) {
    return doc.root.length === 0 && Object.keys(doc.folders).length === 0 && Object.keys(doc.playlists).length === 0;
  }

  /** The ordered child list of the top level (ROOT) or of a folder; null for anything else. */
  function childrenOf(doc, containerId) {
    if (containerId === ROOT) return doc.root;
    const folder = getFolder(doc, containerId);
    return folder ? folder.children : null;
  }

  /** The container (ROOT or a folder ID) that holds a folder or playlist. */
  function parentOf(doc, id) {
    if (doc.root.includes(id)) return ROOT;
    for (const [folderId, folder] of Object.entries(doc.folders)) {
      if (folder.children.includes(id)) return folderId;
    }
    return null;
  }

  /** True when `containerId` is `folderId` itself or a folder somewhere inside it. */
  function isWithin(doc, containerId, folderId) {
    let steps = Object.keys(doc.folders).length + 1;
    for (let c = containerId; c && c !== ROOT && steps-- > 0; c = parentOf(doc, c)) {
      if (c === folderId) return true;
    }
    return false;
  }

  function randomId(length) {
    const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
    const bytes = new Uint8Array(length);
    if (globalThis.crypto?.getRandomValues) globalThis.crypto.getRandomValues(bytes);
    else for (let i = 0; i < length; i++) bytes[i] = Math.floor(Math.random() * 256);
    return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('');
  }

  function newFolderId(doc) {
    let id;
    do id = 'fld_' + randomId(8);
    while (isFolder(doc, id) || isPlaylist(doc, id));
    return id;
  }

  function cleanName(name, fallback) {
    const text = String(name ?? '').replace(/\s+/g, ' ').trim().slice(0, 200);
    return text || fallback;
  }

  /** Drops repeated references to the same entry (by object identity). */
  function uniqueItems(picked) {
    const seen = new Set();
    return picked.filter((p) => !p.item || (!seen.has(p.item) && seen.add(p.item)));
  }

  /** Runs `change` and reports whether any of `lists` ended up different. */
  function changes(lists, change) {
    const before = lists.map((list) => [...list]);
    if (change() === false) return false;
    return lists.some((list, k) => list.length !== before[k].length || list.some((x, i) => x !== before[k][i]));
  }

  // ---------------------------------------------------------------------------
  // Editing

  function addFolder(doc, parentId = ROOT, name = 'New folder') {
    const siblings = childrenOf(doc, parentId);
    if (!siblings) throw new Error(`Cannot add a folder to "${parentId}"`);
    const id = newFolderId(doc);
    doc.folders[id] = { name: cleanName(name, 'New folder'), open: true, children: [] };
    siblings.push(id);
    if (parentId !== ROOT) doc.folders[parentId].open = true;
    return id;
  }

  function renameFolder(doc, id, name) {
    const folder = getFolder(doc, id);
    if (!folder) return false;
    const next = cleanName(name, folder.name);
    if (next === folder.name) return false;
    folder.name = next;
    return true;
  }

  /** Deletes a folder. Its contents move up into its parent, where the folder was. */
  function deleteFolder(doc, id) {
    const folder = getFolder(doc, id);
    if (!folder) return null;
    const parent = parentOf(doc, id);
    const siblings = childrenOf(doc, parent);
    siblings.splice(siblings.indexOf(id), 1, ...folder.children);
    delete doc.folders[id];
    return { parent, moved: folder.children.length };
  }

  /** Deletes several folders; returns how many were deleted. */
  function deleteFolders(doc, ids) {
    return ids.filter((id) => deleteFolder(doc, id)).length;
  }

  /** Opens or closes a folder or playlist (`open` omitted: toggle). Returns the new state. */
  function setOpen(doc, id, open) {
    const node = getFolder(doc, id) || getPlaylist(doc, id);
    if (!node) return null;
    node.open = open === undefined ? !node.open : Boolean(open);
    return node.open;
  }

  /** Whether a folder or playlist may go into `toParent` (ROOT or a folder). */
  function canMoveNode(doc, id, toParent) {
    if (!isFolder(doc, id) && !isPlaylist(doc, id)) return false;
    if (toParent !== ROOT && !isFolder(doc, toParent)) return false;
    if (isFolder(doc, id) && isWithin(doc, toParent, id)) return false;
    return true;
  }

  /**
   * Moves folders and playlists (in the given order) into `toParent`, before the
   * entry currently at `index` (end when omitted). Returns false if nothing changed.
   */
  function moveNodes(doc, nodeIds, toParent, index) {
    const ids = [...new Set(nodeIds)];
    if (!ids.length || !ids.every((id) => canMoveNode(doc, id, toParent))) return false;
    const target = childrenOf(doc, toParent);
    const sources = ids.map((id) => childrenOf(doc, parentOf(doc, id)));
    if (sources.some((list) => !list)) return false;
    return changes([target, ...sources], () => {
      const moving = new Set(ids);
      const before = target.slice(index ?? target.length).find((id) => !moving.has(id)) ?? null;
      ids.forEach((id, k) => sources[k].splice(sources[k].indexOf(id), 1));
      target.splice(before === null ? target.length : target.indexOf(before), 0, ...ids);
    });
  }

  function moveNode(doc, id, toParent, index) {
    return moveNodes(doc, [id], toParent, index);
  }

  /**
   * Moves videos into a playlist, before the entry currently at `index` (end when
   * omitted). `refs` are { playlist, index } in the order they should land.
   * With `copy`, or when they come from a read-only playlist, the videos are
   * copied instead. Returns false if nothing changed.
   */
  function moveVideos(doc, refs, toPlaylist, index, { copy = false } = {}) {
    const target = getPlaylist(doc, toPlaylist);
    if (!target || isReadOnly(target) || !refs.length) return false;
    const picked = uniqueItems(refs.map((ref) => {
      const source = getPlaylist(doc, ref.playlist);
      return { source, item: source?.items[ref.index], copy: copy || isReadOnly(source) };
    }));
    if (picked.some((p) => !p.item)) return false;
    return changes([target.items, ...picked.map((p) => p.source.items)], () => {
      const moving = new Set(picked.filter((p) => !p.copy).map((p) => p.item));
      const before = target.items.slice(index ?? target.items.length).find((item) => !moving.has(item)) ?? null;
      const entries = picked.map(({ source, item, copy: isCopy }) => {
        // A copy is a new playlist entry: it only knows which video it is.
        if (isCopy) return { videoId: item.videoId };
        source.items.splice(source.items.indexOf(item), 1);
        return item;
      });
      target.items.splice(before === null ? target.items.length : target.items.indexOf(before), 0, ...entries);
    });
  }

  function moveVideo(doc, fromPlaylist, fromIndex, toPlaylist, index) {
    return moveVideos(doc, [{ playlist: fromPlaylist, index: fromIndex }], toPlaylist, index);
  }

  /** Removes videos ({ playlist, index }) from their playlists; returns how many were removed. */
  function removeVideos(doc, refs) {
    const picked = uniqueItems(refs
      .map((ref) => ({ source: getPlaylist(doc, ref.playlist), index: ref.index }))
      .filter(({ source }) => source && !isReadOnly(source))
      .map(({ source, index }) => ({ source, item: source.items[index] }))
      .filter(({ item }) => item));
    for (const { source, item } of picked) source.items.splice(source.items.indexOf(item), 1);
    return picked.length;
  }

  /** Captures what edits can change, for undo. Entries are shared, not copied (they never change in place). */
  function snapshot(doc) {
    return {
      root: [...doc.root],
      folders: Object.fromEntries(Object.entries(doc.folders).map(([id, f]) => [id, { ...f, children: [...f.children] }])),
      items: Object.fromEntries(Object.entries(doc.playlists).map(([id, p]) => [id, [...p.items]])),
    };
  }

  /** Puts back a snapshot, keeping folders and playlists open or closed as they are now. */
  function restore(doc, snap) {
    const openNow = (node, fallback) => (node ? node.open : fallback);
    const folders = {};
    for (const [id, folder] of Object.entries(snap.folders)) {
      folders[id] = { ...folder, children: [...folder.children], open: openNow(getFolder(doc, id), folder.open) };
    }
    doc.root = [...snap.root];
    doc.folders = folders;
    for (const [id, items] of Object.entries(snap.items)) {
      if (isPlaylist(doc, id)) doc.playlists[id].items = [...items];
    }
  }

  // ---------------------------------------------------------------------------
  // Reading

  function docStats(doc) {
    let videos = 0;
    for (const playlist of Object.values(doc.playlists)) videos += playlist.items.length;
    return {
      folders: Object.keys(doc.folders).length,
      playlists: Object.keys(doc.playlists).length,
      videos,
    };
  }

  /** Playlists and videos anywhere inside a folder. */
  function folderStats(doc, folderId) {
    const stats = { folders: 0, playlists: 0, videos: 0 };
    const stack = [...(childrenOf(doc, folderId) || [])];
    const seen = new Set();
    while (stack.length) {
      const id = stack.pop();
      if (seen.has(id)) continue;
      seen.add(id);
      if (isFolder(doc, id)) {
        stats.folders++;
        stack.push(...doc.folders[id].children);
      } else if (isPlaylist(doc, id)) {
        stats.playlists++;
        stats.videos += doc.playlists[id].items.length;
      }
    }
    return stats;
  }

  /** "PT1H2M3S" → "1:02:03". Empty for live streams and anything unparseable. */
  function formatDuration(iso) {
    const match = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(iso || '');
    if (!match) return '';
    const [days, hours, minutes, seconds] = match.slice(1).map((n) => Number(n || 0));
    const totalHours = days * 24 + hours;
    if (totalHours + minutes + seconds === 0) return '';
    const pad = (n) => String(n).padStart(2, '0');
    return totalHours ? `${totalHours}:${pad(minutes)}:${pad(seconds)}` : `${minutes}:${pad(seconds)}`;
  }

  /** What the dashboard shows for a video. */
  function videoInfo(doc, videoId) {
    const video = getVideo(doc, videoId);
    return {
      title: video?.snippet?.title || videoId,
      channel: video?.snippet?.channelTitle || '',
      duration: formatDuration(video?.contentDetails?.duration),
      unavailable: !video || video.unavailable === true,
    };
  }

  // ---------------------------------------------------------------------------
  // Validation, import and export

  class BackupError extends Error {
    constructor(problems) {
      super(problems[0] || 'Invalid backup');
      this.name = 'BackupError';
      this.problems = problems;
    }
  }

  /** Lists everything wrong with a document; an empty list means it is valid. */
  function validate(doc) {
    const problems = [];
    let hidden = 0;
    const fail = (message) => {
      if (problems.length < MAX_PROBLEMS) problems.push(message);
      else hidden++;
    };
    const done = () => (hidden ? [...problems, `…and ${hidden} more problems.`] : problems);
    const isStringList = (v) => Array.isArray(v) && v.every((x) => typeof x === 'string');

    if (!isPlainObject(doc)) return ['The file does not contain a JSON object.'];
    if (doc.format !== FORMAT && !LEGACY_FORMATS.includes(doc.format)) {
      return [`This is not a YouTube Playlist Manager backup (expected "format": "${FORMAT}").`];
    }
    if (!Number.isInteger(doc.version) || doc.version < 1) return ['The backup has no valid "version".'];
    if (doc.version > VERSION) {
      return [`This backup was made by a newer version of YouTube Playlist Manager (format ${doc.version}). Update the extension and try again.`];
    }
    if (!Array.isArray(doc.root)) fail('"root" must be a list.');
    for (const key of ['folders', 'playlists', 'videos']) {
      if (!isPlainObject(doc[key])) fail(`"${key}" must be an object.`);
    }
    if (doc.sync !== undefined && !isPlainObject(doc.sync)) fail('"sync" must be an object.');
    if (problems.length) return done();

    const label = (id) => {
      if (isFolder(doc, id) && typeof doc.folders[id]?.name === 'string') return `folder "${doc.folders[id].name}"`;
      if (isPlaylist(doc, id) && typeof doc.playlists[id]?.title === 'string') return `playlist "${doc.playlists[id].title}"`;
      return `"${id}"`;
    };

    for (const [id, folder] of Object.entries(doc.folders)) {
      if (id === ROOT) fail('"root" cannot be used as a folder ID.');
      if (isPlaylist(doc, id)) fail(`"${id}" is used as both a folder and a playlist ID.`);
      if (!isPlainObject(folder)) {
        fail(`Folder "${id}" must be an object.`);
        continue;
      }
      if (typeof folder.name !== 'string') fail(`Folder "${id}" needs a "name".`);
      if (!isStringList(folder.children)) fail(`Folder "${id}" needs a "children" list of IDs.`);
      if (folder.open !== undefined && typeof folder.open !== 'boolean') fail(`Folder "${id}": "open" must be true or false.`);
    }

    for (const [id, playlist] of Object.entries(doc.playlists)) {
      if (id === ROOT) fail('"root" cannot be used as a playlist ID.');
      if (!isPlainObject(playlist)) {
        fail(`Playlist "${id}" must be an object.`);
        continue;
      }
      if (typeof playlist.title !== 'string') fail(`Playlist "${id}" needs a "title".`);
      if (playlist.open !== undefined && typeof playlist.open !== 'boolean') fail(`Playlist "${id}": "open" must be true or false.`);
      if (playlist.kind !== undefined && playlist.kind !== LIKED) fail(`Playlist "${id}": unknown "kind".`);
      if (playlist.synced !== undefined && !isStringList(playlist.synced)) fail(`Playlist "${id}": "synced" must be a list of IDs.`);
      if (playlist.syncedVersion !== undefined && typeof playlist.syncedVersion !== 'string') fail(`Playlist "${id}": "syncedVersion" must be text.`);
      if (!Array.isArray(playlist.items)) {
        fail(`Playlist "${id}" needs an "items" list.`);
        continue;
      }
      playlist.items.forEach((item, i) => {
        if (!isPlainObject(item) || typeof item.videoId !== 'string') {
          fail(`Playlist "${id}", item ${i + 1}: needs a "videoId".`);
        } else if (!hasOwn(doc.videos, item.videoId)) {
          fail(`Playlist "${id}", item ${i + 1}: video "${item.videoId}" is missing from "videos".`);
        } else if (item.itemId !== undefined && typeof item.itemId !== 'string') {
          fail(`Playlist "${id}", item ${i + 1}: "itemId" must be text.`);
        }
      });
    }

    for (const [id, video] of Object.entries(doc.videos)) {
      if (!isPlainObject(video)) fail(`Video "${id}" must be an object.`);
    }
    if (problems.length) return done();

    // Every folder and playlist must sit in exactly one place.
    const placed = new Set();
    const place = (where, ids) => {
      for (const id of ids) {
        if (!isFolder(doc, id) && !isPlaylist(doc, id)) {
          fail(`${where} lists "${id}", which is not a folder or playlist in this file.`);
        } else if (placed.has(id)) {
          fail(`${label(id)} appears in more than one place.`);
        } else {
          placed.add(id);
        }
      }
    };
    place('The top level', doc.root);
    for (const folder of Object.values(doc.folders)) place(`Folder "${folder.name}"`, folder.children);
    for (const id of [...Object.keys(doc.folders), ...Object.keys(doc.playlists)]) {
      if (!placed.has(id)) fail(`${label(id)} is not in any folder or at the top level.`);
    }
    if (problems.length) return done();

    // Anything placed but unreachable from the top level is part of a folder loop.
    const reached = new Set();
    const stack = [...doc.root];
    while (stack.length) {
      const id = stack.pop();
      if (reached.has(id)) continue;
      reached.add(id);
      if (isFolder(doc, id)) stack.push(...doc.folders[id].children);
    }
    for (const id of placed) {
      if (!reached.has(id)) fail(`${label(id)} is inside a loop of folders that contain each other.`);
    }
    return done();
  }

  /** Copies a valid document, keeping unknown per-item fields but dropping unknown top-level ones. */
  function normalize(data) {
    const doc = emptyDoc();
    doc.root = [...data.root];
    for (const [id, folder] of Object.entries(data.folders)) {
      doc.folders[id] = { ...folder, open: folder.open === true, children: [...folder.children] };
    }
    for (const [id, playlist] of Object.entries(data.playlists)) {
      doc.playlists[id] = { ...playlist, open: playlist.open === true, items: playlist.items.map((item) => ({ ...item })) };
    }
    doc.videos = { ...data.videos };
    if (data.sync) doc.sync = { ...data.sync };
    return doc;
  }

  /** Parses backup file text. Throws a BackupError listing the problems if it is invalid. */
  function parseBackup(text) {
    let data;
    try {
      data = JSON.parse(text);
    } catch (err) {
      throw new BackupError([`The file is not valid JSON (${err.message}).`]);
    }
    const problems = validate(data);
    if (problems.length) throw new BackupError(problems);
    return normalize(data);
  }

  function toBackup(doc, now = new Date()) {
    return {
      format: FORMAT,
      version: VERSION,
      exportedAt: now.toISOString(),
      ...(doc.sync ? { sync: doc.sync } : {}),
      root: doc.root,
      folders: doc.folders,
      playlists: doc.playlists,
      videos: doc.videos,
    };
  }

  // ---------------------------------------------------------------------------
  // Helpers for data from the YouTube Data API

  /** Drops API bookkeeping (kind, etag) and snippet.localized when it repeats the title and description. */
  function cleanResource(raw) {
    const { kind, etag, ...rest } = raw;
    if (rest.snippet?.localized) {
      const { localized, ...snippet } = rest.snippet;
      if (localized.title !== snippet.title || localized.description !== snippet.description) {
        snippet.localized = localized;
      }
      rest.snippet = snippet;
    }
    return rest;
  }

  function withoutUndefined(obj) {
    return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined));
  }

  /** Deleted and private videos only exist as playlist entries; keep what the entry says about them. */
  function unavailableVideo(videoId, item) {
    return withoutUndefined({
      id: videoId,
      unavailable: true,
      snippet: withoutUndefined({
        title: item.snippet?.title,
        channelId: item.snippet?.videoOwnerChannelId,
        channelTitle: item.snippet?.videoOwnerChannelTitle,
      }),
      status: item.status,
    });
  }

  const model = {
    FORMAT,
    VERSION,
    ROOT,
    LIKED,
    BackupError,
    emptyDoc,
    isEmpty,
    isFolder,
    isPlaylist,
    isReadOnly,
    getFolder,
    getPlaylist,
    getVideo,
    childrenOf,
    parentOf,
    isWithin,
    addFolder,
    renameFolder,
    deleteFolder,
    deleteFolders,
    setOpen,
    canMoveNode,
    moveNodes,
    moveNode,
    moveVideos,
    moveVideo,
    removeVideos,
    snapshot,
    restore,
    docStats,
    folderStats,
    formatDuration,
    videoInfo,
    validate,
    parseBackup,
    toBackup,
    cleanResource,
    withoutUndefined,
    unavailableVideo,
  };

  PM.model = model;
  if (typeof module === 'object' && module.exports) module.exports = model;
})();
