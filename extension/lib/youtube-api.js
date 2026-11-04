/*
 * YouTube Data API v3 client, used by the background service worker.
 *
 * client({ token, fetch, signal }) returns:
 *   fetchChannel()                       the signed-in channel: { id, title, likedId }
 *   fetchLibrary(channel, options, onProgress)
 *                                        the channel's playlists, the entries of the ones
 *                                        `options` picks, Liked videos and video details
 *   fetchPlaylists()                     just the playlists (to learn their versions after a push)
 *   insertItem / deleteItem / moveItem   add, remove and reposition a playlist entry
 *
 * Quota: each read returns up to 50 results for 1 unit; each write costs 50 units.
 * Reads run several at a time. `fetch` and `sleep` are passed in so the tests can fake them.
 */
(() => {
  'use strict';

  const PM = (globalThis.PM ??= {});

  const API = 'https://www.googleapis.com/youtube/v3';
  const PAGE_SIZE = 50;
  const PARALLEL_READS = 6;
  // Playlist versions (etags) depend on the parts requested, so these must stay the same between syncs.
  const PLAYLIST_PARTS = 'snippet,contentDetails,status';
  const ITEM_PARTS = 'snippet,contentDetails,status';
  const VIDEO_PARTS = 'snippet,contentDetails,statistics,status,topicDetails,recordingDetails,liveStreamingDetails';
  const RETRIES = 3;
  const REQUEST_TIMEOUT_MS = 25000;
  const QUOTA_REASONS = new Set(['quotaExceeded', 'dailyLimitExceeded']);

  class ApiError extends Error {
    constructor(message, { status, reason } = {}) {
      super(message);
      this.name = 'ApiError';
      this.status = status;
      this.reason = reason;
    }
  }

  const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const backoff = (attempt) => 1000 * 2 ** attempt;
  const cancelled = () => new ApiError('The sync was cancelled.', { reason: 'cancelled' });
  const videoIdOf = (item) => item.contentDetails?.videoId ?? item.snippet?.resourceId?.videoId;
  const hasOwn = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);
  const plural = (n, word) => `${n.toLocaleString()} ${word}${n === 1 ? '' : 's'}`;
  const inBatches = (list, size) => Array.from({ length: Math.ceil(list.length / size) }, (_, i) => list.slice(i * size, (i + 1) * size));

  function errorReason(body) {
    const error = body?.error;
    return error?.errors?.[0]?.reason || error?.details?.find((d) => d.reason)?.reason || error?.status;
  }

  function explain(status, reason, message) {
    switch (reason) {
      case 'quotaExceeded':
      case 'dailyLimitExceeded':
        return "Today's YouTube API quota is used up. It resets at midnight Pacific time.";
      case 'accessNotConfigured':
      case 'SERVICE_DISABLED':
        return "The YouTube Data API v3 isn't enabled in your Google Cloud project. Enable it and try again.";
      case 'insufficientPermissions':
      case 'ACCESS_TOKEN_SCOPE_INSUFFICIENT':
        return "Google didn't grant the access this needs. Try again and allow access.";
      case 'youtubeSignupRequired':
      case 'channelNotFound':
        return "This Google account doesn't have a YouTube channel. Pick the account (or brand channel) that owns your playlists.";
      case 'manualSortRequired':
        return "the playlist isn't sorted manually";
      case 'videoNotFound':
        return 'the video no longer exists or is private';
      case 'playlistItemNotFound':
        return 'that entry is already gone from YouTube';
    }
    if (status === 401) return 'Google rejected the sign-in (it may have expired). Try again.';
    return `YouTube API error ${status}${message ? `: ${message}` : ''}`;
  }

  /**
   * One API call, retried when YouTube is briefly unavailable. Adding an entry
   * (POST) is only retried when YouTube says it didn't happen (rate limits):
   * repeating it after an unclear failure could add the video twice.
   */
  async function request(ctx, path, params, { method = 'GET', body } = {}) {
    const url = `${API}/${path}?${new URLSearchParams(params)}`;
    const repeatable = method !== 'POST';
    for (let attempt = 0; ; attempt++) {
      if (ctx.signal?.aborted) throw cancelled();

      // A request that hangs would let Chrome stop the service worker, so time it out.
      const timeout = new AbortController();
      const timer = setTimeout(() => timeout.abort(), REQUEST_TIMEOUT_MS);
      const onCancel = () => timeout.abort();
      ctx.signal?.addEventListener('abort', onCancel);
      let response;
      try {
        response = await ctx.fetch(url, {
          method,
          headers: {
            Authorization: `Bearer ${ctx.token}`,
            Accept: 'application/json',
            ...(body ? { 'Content-Type': 'application/json' } : {}),
          },
          body: body ? JSON.stringify(body) : undefined,
          signal: timeout.signal,
        });
      } catch (err) {
        if (ctx.signal?.aborted) throw cancelled();
        if (repeatable && attempt < RETRIES) {
          await ctx.sleep(backoff(attempt));
          continue;
        }
        throw new ApiError(`Could not reach YouTube (${err.message}).`);
      } finally {
        clearTimeout(timer);
        ctx.signal?.removeEventListener('abort', onCancel);
      }

      if (response.ok) {
        const text = await response.text();
        return text ? JSON.parse(text) : null;
      }

      const errorBody = await response.json().catch(() => null);
      const reason = errorReason(errorBody);
      const rateLimited = response.status === 429 || reason === 'rateLimitExceeded' || reason === 'userRateLimitExceeded';
      if ((rateLimited || (repeatable && response.status >= 500)) && attempt < RETRIES) {
        await ctx.sleep(backoff(attempt));
        continue;
      }
      throw new ApiError(explain(response.status, reason, errorBody?.error?.message), { status: response.status, reason });
    }
  }

  /** Every page of a list, following nextPageToken. */
  async function* pages(ctx, path, params) {
    const seenTokens = new Set();
    let pageToken;
    do {
      const page = await request(ctx, path, { ...params, maxResults: PAGE_SIZE, ...(pageToken ? { pageToken } : {}) });
      yield page;
      pageToken = page.nextPageToken;
      if (pageToken && seenTokens.has(pageToken)) {
        throw new ApiError('YouTube kept returning the same page, so the sync stopped.');
      }
      if (pageToken) seenTokens.add(pageToken);
    } while (pageToken);
  }

  /** Every item of a list. */
  async function listAll(ctx, path, params, onPage) {
    const all = [];
    for await (const page of pages(ctx, path, params)) {
      all.push(...(page.items || []));
      onPage?.(all.length, page.pageInfo?.totalResults);
    }
    return all;
  }

  /** Calls `fn` on every item, a few at a time. After a failure no new calls start, and the first error is thrown. */
  async function inParallel(items, fn) {
    let next = 0;
    let failure = null;
    const worker = async () => {
      while (!failure && next < items.length) {
        const item = items[next++];
        try {
          await fn(item);
        } catch (err) {
          failure ??= err;
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(PARALLEL_READS, items.length) }, worker));
    if (failure) throw failure;
  }

  function uniqueById(resources) {
    const seen = new Set();
    return resources.filter((r) => r?.id && !seen.has(r.id) && seen.add(r.id));
  }

  async function fetchChannel(ctx) {
    const channel = (await request(ctx, 'channels', { part: 'snippet,contentDetails', mine: 'true' })).items?.[0];
    if (!channel) throw new ApiError(explain(404, 'channelNotFound'), { status: 404, reason: 'channelNotFound' });
    return { id: channel.id, title: channel.snippet?.title, likedId: channel.contentDetails?.relatedPlaylists?.likes || null };
  }

  /** Every playlist the signed-in channel owns, as raw API resources. Each has an etag: its current version. */
  async function fetchPlaylists(ctx) {
    return uniqueById(await listAll(ctx, 'playlists', { part: PLAYLIST_PARTS, mine: 'true' }));
  }

  /**
   * The channel's playlists (all of them, as raw API resources), plus:
   *   items   { [playlistId]: entries }, only for the playlists `options.read(playlist)` picks (default: all)
   *   liked   Liked videos: { id, items, version }; or { id, unchanged: true } when it still matches
   *           `options.liked` ({ id, videoIds, version }); or null if the channel has none
   *   videos  { [videoId]: details } for the videos in what was read, except `options.knownVideos`
   *           (a Set); null for videos YouTube no longer describes (deleted or private)
   */
  async function fetchLibrary(ctx, channel, options = {}, onProgress = () => {}) {
    const { read = () => true, liked: knownLiked = null, knownVideos = null } = options;

    onProgress('Checking your playlists…');
    const playlists = await fetchPlaylists(ctx);

    const toRead = playlists.filter((playlist) => read(playlist));
    const what = plural(toRead.length, toRead.length < playlists.length ? 'changed playlist' : 'playlist');
    const items = {};
    let finished = 0;
    let entries = 0;
    const report = () => onProgress(`Reading ${what}… ${finished} of ${toRead.length} (${plural(entries, 'video')})`);
    if (toRead.length) report();
    await inParallel(toRead, async (playlist) => {
      const name = playlist.snippet?.title || playlist.id;
      let counted = 0;
      try {
        items[playlist.id] = await listAll(ctx, 'playlistItems', { part: ITEM_PARTS, playlistId: playlist.id }, (n) => {
          entries += n - counted;
          counted = n;
          report();
        });
      } catch (err) {
        if (err.reason !== 'cancelled') err.message += ` (while reading playlist “${name}”)`;
        throw err;
      }
      finished++;
      report();
    });

    const videos = {};
    let liked = null;
    if (channel.likedId) {
      const known = knownLiked?.id === channel.likedId ? knownLiked : null;
      liked = await fetchLiked(ctx, channel.likedId, known, videos, onProgress);
    }

    const readEntries = [...Object.values(items).flat(), ...(liked?.items || [])];
    const wanted = [...new Set(readEntries.map(videoIdOf))].filter((id) => id && !hasOwn(videos, id) && !knownVideos?.has(id));
    let described = 0;
    await inParallel(inBatches(wanted, PAGE_SIZE), async (ids) => {
      // maxResults can't be combined with id: every video asked for is returned.
      const page = await request(ctx, 'videos', { part: VIDEO_PARTS, id: ids.join(',') });
      for (const id of ids) videos[id] = null;
      for (const video of page.items || []) videos[video.id] = video;
      described += ids.length;
      onProgress(`Reading video details… ${described} of ${wanted.length}`);
    });

    return { channel: { id: channel.id, title: channel.title }, playlists, items, liked, videos };
  }

  /**
   * Liked videos. New likes go to the top, so when its first page and its size are what
   * `known` says, nothing has changed and the rest isn't read: { id, unchanged: true }.
   */
  async function fetchLiked(ctx, id, known, videos, onProgress) {
    onProgress('Checking your liked videos…');
    const progress = (n, total) => onProgress(`Reading your liked videos… ${n}${total ? ` of ${total}` : ''}`);
    try {
      return await readLiked(ctx, id, known, 'playlistItems', { part: ITEM_PARTS, playlistId: id }, videoIdOf, progress);
    } catch (err) {
      if (!(err.status === 404 || (err.status === 403 && !QUOTA_REASONS.has(err.reason)))) throw err;
    }
    // Some accounts don't expose the Liked videos playlist; the videos rated "like" are the same list.
    const rated = await readLiked(ctx, id, known, 'videos', { part: VIDEO_PARTS, myRating: 'like' }, (video) => video.id, progress);
    if (rated.unchanged) return rated;
    for (const video of rated.items) videos[video.id] = video;
    return {
      ...rated,
      items: rated.items.map((video) => ({ snippet: { title: video.snippet?.title, resourceId: { videoId: video.id } }, contentDetails: { videoId: video.id } })),
    };
  }

  async function readLiked(ctx, id, known, path, params, videoOf, progress) {
    const items = [];
    let version;
    let first = true;
    for await (const page of pages(ctx, path, params)) {
      const pageItems = page.items || [];
      if (first) {
        first = false;
        const total = page.pageInfo?.totalResults;
        version = total == null ? undefined : String(total);
        if (known && version !== undefined && version === known.version && startsWith(known.videoIds, pageItems.map(videoOf), !page.nextPageToken)) {
          return { id, unchanged: true };
        }
      }
      items.push(...pageItems);
      progress(items.length, page.pageInfo?.totalResults);
    }
    return { id, items, version };
  }

  /** Whether `list` starts with `start` (and has nothing more, if `whole`). */
  function startsWith(list, start, whole) {
    if (whole ? list.length !== start.length : list.length < start.length) return false;
    return start.every((value, i) => value === list[i]);
  }

  const resource = (playlistId, videoId, position) => ({
    playlistId,
    resourceId: { kind: 'youtube#video', videoId },
    position, // omitted from the JSON when undefined: add at the end
  });

  function client({ token, fetch, signal, sleep = defaultSleep }) {
    const ctx = { token, fetch, signal, sleep };
    return {
      fetchChannel: () => fetchChannel(ctx),
      fetchPlaylists: () => fetchPlaylists(ctx),
      fetchLibrary: (channel, options, onProgress) => fetchLibrary(ctx, channel, options, onProgress),
      insertItem: ({ playlistId, videoId, position }) =>
        request(ctx, 'playlistItems', { part: 'snippet' }, { method: 'POST', body: { snippet: resource(playlistId, videoId, position) } }),
      deleteItem: (itemId) => request(ctx, 'playlistItems', { id: itemId }, { method: 'DELETE' }),
      moveItem: ({ itemId, playlistId, videoId, position }) =>
        request(ctx, 'playlistItems', { part: 'snippet' }, { method: 'PUT', body: { id: itemId, snippet: resource(playlistId, videoId, position) } }),
    };
  }

  const youtube = { API, VIDEO_PARTS, ApiError, client };

  PM.youtube = youtube;
  if (typeof module === 'object' && module.exports) module.exports = youtube;
})();
