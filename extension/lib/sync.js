/*
 * Two-way sync between the library and YouTube.
 *
 * Each YouTube playlist remembers the YouTube entry IDs it had at the last
 * pull or push (`synced`), and each entry here remembers its own YouTube ID
 * (`itemId`). Comparing what YouTube had then, what it has now and what is
 * here tells changes made on YouTube apart from changes made here:
 *
 *   readOptions(doc)              what a pull needs to read: only playlists that changed
 *   merge(doc, remote)            pull: YouTube's changes come in, changes made here are kept
 *   planPush(doc)                 what a push would add, remove and reorder on YouTube
 *   executePush(doc, plan, api)   push: does it, keeping `synced` true to YouTube after every call
 *
 * Each playlist also remembers YouTube's version tag for it (its etag) from
 * when `synced` was read (`syncedVersion`). The tag changes when YouTube's
 * description of the playlist changes (its title, its number of videos, its
 * thumbnail…), so a pull reads only playlists whose tag is new.
 *
 * Folders only exist here. Liked videos is read-only: a pull replaces it and
 * a push leaves it alone. Pure data code: no DOM, no chrome.* APIs.
 */
(() => {
  'use strict';

  const PM = (globalThis.PM ??= {});

  const QUOTA_PER_CHANGE = 50; // playlistItems insert, update and delete each cost 50 units
  const DAILY_QUOTA = 10000;
  const CHECKPOINT_EVERY = 10;
  const FATAL_REASONS = new Set(['quotaExceeded', 'dailyLimitExceeded', 'insufficientPermissions', 'ACCESS_TOKEN_SCOPE_INSUFFICIENT', 'cancelled']);

  const M = () => PM.model;
  const plural = (n, word) => `${n.toLocaleString()} ${word}${n === 1 ? '' : 's'}`;
  const videoIdOf = (raw) => raw.contentDetails?.videoId ?? raw.snippet?.resourceId?.videoId;
  const hasOwn = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);
  const sameOrder = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

  /** YouTube's entries for one playlist, in order. */
  function entriesOf(rawItems = []) {
    const entries = [];
    for (const raw of rawItems) {
      const videoId = videoIdOf(raw);
      if (videoId) entries.push({ itemId: raw.id, videoId, addedAt: raw.snippet?.publishedAt, note: raw.contentDetails?.note, raw });
    }
    return entries;
  }

  const toItem = (entry) =>
    M().withoutUndefined({ videoId: entry.videoId, addedAt: entry.addedAt, note: entry.note, itemId: entry.itemId });

  /** The YouTube channel the library's playlists came from, or null if it has none. */
  function libraryChannel(doc) {
    if (doc.sync?.channelId) return { id: doc.sync.channelId, title: doc.sync.channelTitle };
    for (const playlist of Object.values(doc.playlists)) {
      const snippet = playlist.youtube?.snippet;
      if (snippet?.channelId) return { id: snippet.channelId, title: snippet.channelTitle };
    }
    return null;
  }

  function removePlaylist(doc, id) {
    const siblings = M().childrenOf(doc, M().parentOf(doc, id));
    if (siblings) siblings.splice(siblings.indexOf(id), 1);
    delete doc.playlists[id];
  }

  function setVersion(playlist, version) {
    if (version) playlist.syncedVersion = version;
    else delete playlist.syncedVersion;
  }

  // ---------------------------------------------------------------------------
  // What to read

  /**
   * Whether a pull must read a playlist's entries: it's new here, or YouTube's
   * version tag for it isn't the one its entries were last read at.
   */
  function needsReading(doc, resource) {
    const playlist = M().getPlaylist(doc, resource.id);
    return !playlist || !Array.isArray(playlist.synced) || !resource.etag || playlist.syncedVersion !== resource.etag;
  }

  /**
   * What a pull reads (the options of fetchLibrary in youtube-api.js): playlists
   * that are new or changed on YouTube, plus `targets`, which are always read
   * (a push reads the playlists it's about to change); Liked videos if it
   * changed; details of videos new to the library. `full` reads everything again.
   */
  function readOptions(doc, { full = false, targets = [] } = {}) {
    if (full) return {};
    const always = new Set(targets);
    const [likedId, liked] = Object.entries(doc.playlists).find(([, playlist]) => M().isReadOnly(playlist)) || [];
    return {
      read: (resource) => always.has(resource.id) || needsReading(doc, resource),
      liked: liked?.syncedVersion ? { id: likedId, videoIds: liked.items.map((item) => item.videoId), version: liked.syncedVersion } : null,
      knownVideos: new Set(Object.keys(doc.videos)),
    };
  }

  // ---------------------------------------------------------------------------
  // Pull

  /** Brings one playlist's entries up to date with YouTube's, keeping changes made here. */
  function mergeEntries(playlist, entries) {
    const before = new Set(playlist.synced || []);
    const now = new Set(entries.map((e) => e.itemId));
    let removed = 0;

    // Gone from YouTube since the last sync: remove it here too.
    playlist.items = playlist.items.filter((item) => {
      const gone = Boolean(item.itemId) && before.has(item.itemId) && !now.has(item.itemId);
      if (gone) removed++;
      return !gone;
    });

    const held = new Map(); // YouTube entry ID → the entry here that is it
    for (const item of playlist.items) {
      if (item.itemId && now.has(item.itemId) && !held.has(item.itemId)) held.set(item.itemId, item);
    }
    const reordered = followReorder(playlist, held, before, entries);
    const matched = new Set(held.values());

    let added = 0;
    entries.forEach((entry, index) => {
      if (held.has(entry.itemId)) return;
      // On YouTube at the last sync but not here: it was removed or moved away here. Keep that.
      if (before.has(entry.itemId)) return;
      // New on YouTube (or this is the first sync). If the same video was added here, that's this entry.
      const twin = playlist.items.find((item) => item.videoId === entry.videoId && !matched.has(item));
      if (twin) {
        twin.itemId = entry.itemId;
        held.set(entry.itemId, twin);
        matched.add(twin);
        return;
      }
      // Otherwise add it after the nearest entry that precedes it on YouTube.
      let at = 0;
      for (let k = index - 1; k >= 0; k--) {
        const neighbour = held.get(entries[k].itemId);
        if (neighbour) {
          at = playlist.items.indexOf(neighbour) + 1;
          break;
        }
      }
      const item = toItem(entry);
      playlist.items.splice(at, 0, item);
      held.set(entry.itemId, item);
      matched.add(item);
      added++;
    });

    playlist.synced = entries.map((e) => e.itemId);
    return { added, removed, reordered };
  }

  /**
   * Takes YouTube's order when it was changed there and not here: if the entries
   * on both sides are still in the order they had at the last sync here, but not
   * on YouTube, they're put in YouTube's order. Entries only here keep their places.
   */
  function followReorder(playlist, held, before, entries) {
    const slots = []; // where the entries both sides have sit here
    playlist.items.forEach((item, i) => {
      if (before.has(item.itemId) && held.get(item.itemId) === item) slots.push(i);
    });
    const shared = new Set(slots.map((i) => playlist.items[i].itemId));
    const here = slots.map((i) => playlist.items[i].itemId);
    const then = (playlist.synced || []).filter((itemId) => shared.has(itemId));
    const there = entries.map((e) => e.itemId).filter((itemId) => shared.has(itemId));
    if (!sameOrder(here, then) || sameOrder(there, then)) return false;
    const items = [...playlist.items];
    there.forEach((itemId, k) => {
      items[slots[k]] = held.get(itemId);
    });
    playlist.items = items;
    return true;
  }

  /**
   * Pull: merges what YouTube has now (`remote`, from fetchLibrary in youtube-api.js)
   * into the library. New playlists go to the top level; playlists deleted on YouTube
   * are removed; within a playlist that was read, entries added or removed on YouTube
   * are added or removed here, while moves and removals made here (and not yet pushed)
   * are kept. Playlists that weren't read haven't changed on YouTube. Returns a summary.
   */
  function merge(doc, remote, now = new Date()) {
    const model = M();
    const summary = {
      first: !Object.values(doc.playlists).some((p) => p.youtube),
      read: 0,
      newPlaylists: [],
      removedPlaylists: [],
      renamed: [],
      changed: [],
      likedAdded: false,
      liked: null,
      videosChanged: false, // whether doc.videos changed (it's large, so it's only saved when it did)
    };
    const remoteIds = new Set(remote.playlists.map((p) => p.id));
    const read = remote.items || {};

    for (const [id, playlist] of Object.entries(doc.playlists)) {
      if (model.isReadOnly(playlist) || !playlist.youtube || remoteIds.has(id)) continue;
      removePlaylist(doc, id);
      summary.removedPlaylists.push(playlist.title);
    }

    const fallbacks = new Map(); // videoId → a YouTube entry, for videos YouTube no longer describes
    const remember = (entries) => {
      for (const e of entries) if (!fallbacks.has(e.videoId)) fallbacks.set(e.videoId, e.raw);
    };

    for (const raw of remote.playlists) {
      if (!hasOwn(read, raw.id)) continue; // unchanged on YouTube since its entries were last read
      summary.read++;
      const entries = entriesOf(read[raw.id]);
      remember(entries);
      const title = raw.snippet?.title || 'Untitled playlist';
      const youtube = model.cleanResource(raw);
      const playlist = model.getPlaylist(doc, raw.id);
      if (!playlist) {
        const added = { title, open: false, items: entries.map(toItem), youtube, synced: entries.map((e) => e.itemId) };
        setVersion(added, raw.etag);
        doc.playlists[raw.id] = added;
        doc.root.push(raw.id);
        summary.newPlaylists.push({ title, videos: entries.length });
        continue;
      }
      if (playlist.title !== title) summary.renamed.push({ from: playlist.title, to: title });
      playlist.title = title;
      playlist.youtube = youtube;
      setVersion(playlist, raw.etag);
      const { added, removed, reordered } = mergeEntries(playlist, entries);
      if (added || removed || reordered) summary.changed.push({ title, added, removed, reordered });
    }

    if (remote.liked && !remote.liked.unchanged) {
      const entries = entriesOf(remote.liked.items);
      remember(entries);
      let liked = model.getPlaylist(doc, remote.liked.id);
      if (!liked) {
        liked = doc.playlists[remote.liked.id] = { title: 'Liked videos', open: false, items: [] };
        doc.root.unshift(remote.liked.id);
        summary.likedAdded = true;
      }
      liked.kind = model.LIKED;
      liked.items = entries.map(toItem);
      liked.synced = entries.map((e) => e.itemId).filter(Boolean);
      setVersion(liked, remote.liked.version);
    }
    if (remote.liked) summary.liked = model.getPlaylist(doc, remote.liked.id)?.items.length ?? null;

    // Video details: YouTube's latest for the videos it was asked about; videos it no
    // longer describes are kept but marked unavailable.
    for (const [id, video] of Object.entries(remote.videos || {})) {
      const known = model.getVideo(doc, id);
      if (video) doc.videos[id] = model.cleanResource(video);
      else if (!known) doc.videos[id] = model.unavailableVideo(id, fallbacks.get(id) || {});
      else if (!known.unavailable) doc.videos[id] = { ...known, unavailable: true };
      else continue;
      summary.videosChanged = true;
    }
    const used = new Set();
    for (const playlist of Object.values(doc.playlists)) {
      for (const item of playlist.items) {
        used.add(item.videoId);
        if (model.getVideo(doc, item.videoId)) continue;
        doc.videos[item.videoId] = model.unavailableVideo(item.videoId, fallbacks.get(item.videoId) || {});
        summary.videosChanged = true;
      }
    }
    for (const id of Object.keys(doc.videos)) {
      if (used.has(id)) continue;
      delete doc.videos[id];
      summary.videosChanged = true;
    }

    doc.sync = { ...doc.sync, channelId: remote.channel.id, channelTitle: remote.channel.title, pulledAt: now.toISOString() };

    let videos = 0;
    for (const playlist of Object.values(doc.playlists)) if (!model.isReadOnly(playlist)) videos += playlist.items.length;
    summary.playlists = remote.playlists.length;
    summary.videos = videos;
    return summary;
  }

  /** The message shown after a pull. `waiting` = changes here not yet pushed. */
  function describePull(summary, waiting = 0) {
    const liked = summary.liked == null ? '' : `, plus ${plural(summary.liked, 'liked video')}`;
    const later = waiting ? ` ${plural(waiting, 'change')} made here ${waiting === 1 ? "isn't" : "aren't"} on YouTube yet; Push to send ${waiting === 1 ? 'it' : 'them'}.` : '';
    if (summary.first) {
      return {
        kind: 'success',
        text: `Pulled ${plural(summary.playlists, 'playlist')} with ${plural(summary.videos, 'video')}${liked}. ` +
          `Everything is at the top level, ready to sort into folders.${later}`,
      };
    }
    const details = [];
    if (summary.likedAdded) details.push(`Added Liked videos (${plural(summary.liked, 'video')}) at the top`);
    for (const p of summary.newPlaylists) details.push(`New playlist “${p.title}” (${plural(p.videos, 'video')}), added at the top level`);
    for (const p of summary.changed) {
      const parts = [p.added && plural(p.added, 'new video'), p.removed && `${p.removed} removed`, p.reordered && 'reordered'].filter(Boolean);
      details.push(`“${p.title}”: ${parts.join(', ')} on YouTube`);
    }
    for (const r of summary.renamed) details.push(`“${r.from}” was renamed to “${r.to}” on YouTube`);
    for (const title of summary.removedPlaylists) details.push(`“${title}” was deleted on YouTube, so it was removed here`);
    if (!details.length) return { kind: 'success', text: `Already up to date with YouTube.${later}` };
    return { kind: 'success', text: `Pulled the latest from YouTube.${later}`, details };
  }

  // ---------------------------------------------------------------------------
  // Push

  /** Indexes into `seq` of one longest increasing subsequence. */
  function longestIncreasing(seq) {
    const tails = [];
    const prev = new Array(seq.length);
    for (let i = 0; i < seq.length; i++) {
      let lo = 0;
      let hi = tails.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (seq[tails[mid]] < seq[i]) lo = mid + 1;
        else hi = mid;
      }
      prev[i] = lo > 0 ? tails[lo - 1] : -1;
      tails[lo] = i;
    }
    const result = [];
    for (let i = tails.length ? tails[tails.length - 1] : -1; i >= 0; i = prev[i]) result.push(i);
    return result.reverse();
  }

  /**
   * The fewest single moves that turn `current` into `target` (the same entries in
   * another order). Each move puts `token` at `position` in the list as it is then.
   */
  function reorderMoves(current, target) {
    const where = new Map(current.map((token, i) => [token, i]));
    const stay = new Set(longestIncreasing(target.map((token) => where.get(token))).map((k) => target[k]));
    const list = [...current];
    const moves = [];
    target.forEach((token, k) => {
      if (stay.has(token)) return;
      list.splice(list.indexOf(token), 1);
      const position = k === 0 ? 0 : list.indexOf(target[k - 1]) + 1;
      list.splice(position, 0, token);
      moves.push({ token, position });
    });
    return moves;
  }

  /** Where each new entry would be added: right after the entry that precedes it here. */
  function withAdditions(current, target) {
    const list = [...current];
    target.forEach((token, k) => {
      if (typeof token === 'string') return;
      list.splice(k === 0 ? 0 : list.indexOf(target[k - 1]) + 1, 0, token);
    });
    return list;
  }

  /**
   * What pushing one playlist means. Entries here that are its YouTube entries
   * keep their ID; every other entry (copied or moved in) must be added; YouTube
   * entries no longer here must be removed; then the order must match.
   */
  function planPlaylist(id, playlist) {
    const onYouTube = new Set(playlist.synced);
    const kept = new Set();
    const target = []; // YouTube entry IDs, and { item } for entries to add
    let adds = 0;
    for (const item of playlist.items) {
      if (item.itemId && onYouTube.has(item.itemId) && !kept.has(item.itemId)) {
        kept.add(item.itemId);
        target.push(item.itemId);
      } else {
        target.push({ item });
        adds++;
      }
    }
    const removals = playlist.synced.filter((itemId) => !kept.has(itemId));
    const gone = new Set(removals);
    const afterwards = withAdditions(playlist.synced, target).filter((token) => !gone.has(token));
    return { id, title: playlist.title, target, adds, removals, moves: reorderMoves(afterwards, target).length };
  }

  /** Playlist IDs in the order the tree shows them. */
  function inTreeOrder(doc) {
    const ids = [];
    const visit = (id) => {
      if (M().isFolder(doc, id)) doc.folders[id].children.forEach(visit);
      else if (M().isPlaylist(doc, id)) ids.push(id);
    };
    doc.root.forEach(visit);
    return ids;
  }

  /**
   * Everything a push would change on YouTube, playlist by playlist in tree order.
   * `only` (playlist IDs) limits it to those playlists.
   */
  function planPush(doc, only = null) {
    const allowed = only && new Set(only);
    const playlists = [];
    for (const id of inTreeOrder(doc)) {
      if (allowed && !allowed.has(id)) continue;
      const playlist = doc.playlists[id];
      if (M().isReadOnly(playlist) || !playlist.youtube || !Array.isArray(playlist.synced)) continue;
      const plan = planPlaylist(id, playlist);
      if (plan.adds || plan.removals.length || plan.moves) playlists.push(plan);
    }
    const total = playlists.reduce((n, p) => n + p.adds + p.removals.length + p.moves, 0);
    return { playlists, total, units: total * QUOTA_PER_CHANGE };
  }

  /** Changes waiting to be pushed, per playlist. */
  function pending(doc) {
    const plan = planPush(doc);
    return { total: plan.total, byPlaylist: new Map(plan.playlists.map((p) => [p.id, p.adds + p.removals.length + p.moves])) };
  }

  /** The question asked before a push. */
  function describePlan(plan) {
    const details = plan.playlists.map((p) => {
      const parts = [
        p.adds && `add ${plural(p.adds, 'video')}`,
        p.removals.length && `remove ${plural(p.removals.length, 'video')}`,
        p.moves && `reorder (${plural(p.moves, 'move')})`,
      ].filter(Boolean);
      return `“${p.title}”: ${parts.join(', ')}`;
    });
    let text = `Push ${plural(plan.total, 'change')} to YouTube? This uses about ${plan.units.toLocaleString()} of your ` +
      `${DAILY_QUOTA.toLocaleString()} daily API units.`;
    if (plan.units > DAILY_QUOTA) text += " That's more than a day's worth: the push stops when the quota runs out, and pushing again tomorrow finishes it.";
    return { text, details, confirm: `Push ${plural(plan.total, 'change')}` };
  }

  /** Errors after which nothing else will work either. */
  function isFatal(err) {
    return err?.name !== 'ApiError' || err.status === undefined || err.status === 401 || err.status >= 500 || FATAL_REASONS.has(err.reason);
  }

  /**
   * Before a push: the playlists it changes will get new versions on YouTube. Until
   * those are known (recordVersions), the next pull reads these playlists.
   */
  function forgetVersions(doc, ids) {
    for (const id of ids) {
      const playlist = M().getPlaylist(doc, id);
      if (playlist) delete playlist.syncedVersion;
    }
  }

  /**
   * After a push: takes the pushed playlists' new versions from `resources` (the
   * playlists as YouTube describes them now). A playlist whose number of videos
   * isn't what the push left was also changed elsewhere meanwhile; it gets no
   * version, so the next pull reads it.
   */
  function recordVersions(doc, ids, resources) {
    const byId = new Map(resources.map((raw) => [raw.id, raw]));
    for (const id of ids) {
      const playlist = M().getPlaylist(doc, id);
      const raw = byId.get(id);
      if (!playlist || !raw?.etag || !Array.isArray(playlist.synced) || raw.contentDetails?.itemCount !== playlist.synced.length) continue;
      playlist.title = raw.snippet?.title || playlist.title;
      playlist.youtube = M().cleanResource(raw);
      playlist.syncedVersion = raw.etag;
    }
  }

  /**
   * Push: applies `plan` with api.insert({ playlistId, videoId, position }),
   * api.remove(itemId) and api.move({ itemId, playlistId, videoId, position }).
   * Additions go first and removals after, so a video moved between playlists is
   * never missing from both. After every call the playlist's `synced` list matches
   * YouTube, so a push that stops halfway can simply be run again.
   */
  async function executePush(doc, plan, { insert, remove, move, onProgress = () => {}, checkpoint = async () => {} }) {
    const result = { done: 0, total: plan.total, failed: [], unordered: [], stopped: null };
    const states = plan.playlists.map((p) => ({
      id: p.id,
      title: p.title,
      playlist: doc.playlists[p.id],
      removals: p.removals,
      target: [...p.target],
      current: [...doc.playlists[p.id].synced],
      manual: true,
      blocked: false,
    }));
    const title = (videoId) => M().videoInfo(doc, videoId).title;
    const failed = (state, what, err) => result.failed.push(`“${state.title}”: couldn't ${what} (${err.message})`);
    const done = async (state) => {
      state.playlist.synced = state.current.filter((token) => typeof token === 'string');
      result.done++;
      onProgress(result.done, plan.total);
      if (result.done % CHECKPOINT_EVERY === 0) await checkpoint();
    };

    try {
      // 1. Add, next to the entry that precedes it here (at the end if the playlist isn't sorted manually).
      for (const s of states) {
        for (let k = 0; k < s.target.length; k++) {
          const token = s.target[k];
          if (typeof token === 'string') continue;
          const { videoId } = token.item;
          let response;
          try {
            const position = k === 0 ? 0 : s.current.indexOf(s.target[k - 1]) + 1;
            response = await insert({ playlistId: s.id, videoId, position: s.manual ? position : undefined });
            s.current.splice(s.manual ? position : s.current.length, 0, response.id);
          } catch (err) {
            if (isFatal(err)) throw err;
            if (err.reason === 'manualSortRequired' && s.manual) {
              s.manual = false;
              k--; // try again without a position
              continue;
            }
            failed(s, `add “${title(videoId)}”`, err);
            s.target.splice(k--, 1);
            continue;
          }
          token.item.itemId = response.id;
          s.target[k] = response.id;
          await done(s);
        }
      }

      // 2. Remove.
      for (const s of states) {
        for (const itemId of s.removals) {
          try {
            await remove(itemId);
          } catch (err) {
            if (isFatal(err)) throw err;
            if (err.status !== 404) { // 404: already gone from YouTube
              failed(s, 'remove a video', err);
              s.blocked = true;
              continue;
            }
          }
          s.current.splice(s.current.indexOf(itemId), 1);
          await done(s);
        }
      }

      // 3. Reorder, one move at a time: each position depends on the moves before it.
      for (const s of states) {
        if (s.blocked) continue;
        const videoOf = new Map(s.playlist.items.filter((item) => item.itemId).map((item) => [item.itemId, item.videoId]));
        while (s.manual && !sameOrder(s.current, s.target)) {
          const [next] = reorderMoves(s.current, s.target);
          try {
            await move({ itemId: next.token, playlistId: s.id, videoId: videoOf.get(next.token), position: next.position });
          } catch (err) {
            if (isFatal(err)) throw err;
            if (err.reason === 'manualSortRequired') {
              s.manual = false;
              break;
            }
            failed(s, 'reorder it', err);
            break;
          }
          s.current.splice(s.current.indexOf(next.token), 1);
          s.current.splice(next.position, 0, next.token);
          await done(s);
        }
        if (!s.manual && !sameOrder(s.current, s.target)) result.unordered.push(s.title);
      }
    } catch (err) {
      result.stopped = err;
    }
    await checkpoint();
    return result;
  }

  /** The message shown after a push. */
  function describePush(result) {
    const details = [...result.failed];
    for (const t of result.unordered) {
      details.push(`“${t}” couldn't be reordered because it isn't sorted manually on YouTube. Set its sort order to Manual there, then push again.`);
    }
    if (result.stopped) {
      return {
        kind: 'error',
        text: `Pushed ${result.done} of ${plural(result.total, 'change')}, then stopped: ${result.stopped.message} ` +
          'Push again to finish; nothing is sent twice.',
        details,
      };
    }
    if (details.length) return { kind: 'error', text: `Pushed ${plural(result.done, 'change')} to YouTube, with problems:`, details };
    return { kind: 'success', text: `Pushed ${plural(result.done, 'change')} to YouTube.` };
  }

  const sync = {
    QUOTA_PER_CHANGE,
    libraryChannel,
    needsReading,
    readOptions,
    merge,
    describePull,
    reorderMoves,
    planPush,
    pending,
    describePlan,
    forgetVersions,
    executePush,
    recordVersions,
    describePush,
  };

  PM.sync = sync;
  if (typeof module === 'object' && module.exports) module.exports = sync;
})();
