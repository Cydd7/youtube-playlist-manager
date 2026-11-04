/*
 * An in-memory YouTube Data API for tests: enough of channels, playlists,
 * playlistItems and videos to pull a library and push changes back, with the
 * rules that matter (manual sort order, missing videos, read-only sign-ins,
 * daily quota). Runs in Node and, evaluated as a script, in the extension's
 * service worker (it only needs fetch's Request/Response globals).
 *
 *   const yt = createFakeYouTube({ playlists: [{ id, title, videos: [videoId, …] }], liked: [videoId, …], videos: { id: { title } } });
 *   yt.fetch(url, init)   // drop-in for fetch
 *   yt.videosIn(id)       // a playlist's video IDs on "YouTube"
 *   yt.state.requests     // every request: { method, path, params }
 *
 * Like YouTube's, a playlist's etag only changes when what the API says about
 * the playlist changes (here: its title, privacy, size and first video), not
 * when videos further down are swapped or reordered.
 */
(() => {
  function createFakeYouTube({
    channel = { id: 'UCfakechannel', title: 'Fake Channel' },
    playlists = [],
    liked = [],
    videos = {},
    pageSize = 50,
    quota = 10000,
    likedPlaylist = 'visible', // 'visible' | 'hidden' (listed, but reading it fails) | 'none'
    tokens = { 'read-token': 'read', 'write-token': 'write' },
  } = {}) {
    let nextId = 1;
    const newItem = (videoId) => ({ id: `item${String(nextId++).padStart(4, '0')}`, videoId });
    const state = {
      channel,
      videos: { ...videos },
      playlists: playlists.map((p) => ({
        id: p.id,
        title: p.title,
        privacy: p.privacy || 'private',
        manual: p.manual !== false,
        items: (p.videos || []).map(newItem),
      })),
      liked: liked.map(newItem),
      quota,
      used: 0,
      calls: [],
      requests: [],
    };

    const find = (id) => state.playlists.find((p) => p.id === id);
    const json = (body, status = 200) =>
      new Response(body == null ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    const fail = (status, reason, message = reason) => json({ error: { code: status, message, errors: [{ reason, message }] } }, status);

    function page(all, params) {
      const size = Math.min(Number(params.get('maxResults') || 5), pageSize);
      const start = Number(params.get('pageToken') || 0);
      const next = start + size < all.length ? String(start + size) : undefined;
      return json({ items: all.slice(start, start + size), nextPageToken: next, pageInfo: { totalResults: all.length, resultsPerPage: size } });
    }

    const videoResource = (id) => ({
      kind: 'youtube#video',
      etag: 'e',
      id,
      snippet: {
        title: state.videos[id].title,
        description: state.videos[id].description || '',
        channelId: 'UCowner',
        channelTitle: state.videos[id].channelTitle || 'Some Channel',
      },
      contentDetails: { duration: state.videos[id].duration || 'PT3M30S' },
      statistics: { viewCount: '42' },
    });

    const itemResource = (playlistId, item, position) => {
      const video = state.videos[item.videoId];
      return {
        kind: 'youtube#playlistItem',
        etag: 'e',
        id: item.id,
        snippet: {
          playlistId,
          position,
          publishedAt: '2025-01-01T00:00:00Z',
          title: video ? video.title : 'Deleted video',
          resourceId: { kind: 'youtube#video', videoId: item.videoId },
          ...(video ? { videoOwnerChannelTitle: video.channelTitle || 'Some Channel' } : {}),
        },
        contentDetails: { videoId: item.videoId },
        status: { privacyStatus: video ? 'public' : 'privacyStatusUnspecified' },
      };
    };

    async function fetch(href, init = {}) {
      const url = new URL(href);
      const params = url.searchParams;
      const method = (init.method || 'GET').toUpperCase();
      const path = url.pathname.split('/').pop();
      state.calls.push(`${method} ${path}`);
      state.requests.push({ method, path, params: Object.fromEntries(params) });

      const access = tokens[(init.headers?.Authorization || '').replace(/^Bearer /, '')];
      if (!access) return fail(401, 'authError', 'Invalid Credentials');
      const write = method !== 'GET';
      if (write && access !== 'write') return fail(403, 'insufficientPermissions', 'Request had insufficient authentication scopes.');
      const cost = write ? 50 : 1;
      if (state.used + cost > state.quota) return fail(403, 'quotaExceeded', 'The request cannot be completed because you have exceeded your quota.');
      state.used += cost;
      const body = init.body ? JSON.parse(init.body) : null;

      switch (`${method} ${path}`) {
        case 'GET channels':
          return json({
            items: [{
              id: state.channel.id,
              snippet: { title: state.channel.title },
              contentDetails: { relatedPlaylists: likedPlaylist === 'none' ? {} : { likes: 'LL' } },
            }],
          });

        case 'GET playlists':
          return page(state.playlists.map((p) => ({
            kind: 'youtube#playlist',
            etag: `v:${p.title}|${p.privacy}|${p.items.length}|${p.items[0]?.videoId ?? ''}`,
            id: p.id,
            snippet: { title: p.title, channelId: state.channel.id, channelTitle: state.channel.title },
            status: { privacyStatus: p.privacy },
            contentDetails: { itemCount: p.items.length },
          })), params);

        case 'GET playlistItems': {
          const id = params.get('playlistId');
          if (id === 'LL') {
            if (likedPlaylist !== 'visible') return fail(404, 'playlistNotFound', 'The playlist cannot be found.');
            return page(state.liked.map((item, i) => itemResource('LL', item, i)), params);
          }
          const playlist = find(id);
          if (!playlist) return fail(404, 'playlistNotFound', 'The playlist cannot be found.');
          return page(playlist.items.map((item, i) => itemResource(id, item, i)), params);
        }

        case 'GET videos':
          if (params.get('myRating') === 'like') {
            return page(state.liked.filter((item) => state.videos[item.videoId]).map((item) => videoResource(item.videoId)), params);
          }
          return json({ items: params.get('id').split(',').filter((id) => state.videos[id]).map(videoResource) });

        case 'POST playlistItems': {
          const { playlistId, resourceId, position } = body.snippet;
          const playlist = find(playlistId);
          if (!playlist) return fail(404, 'playlistNotFound', 'The playlist cannot be found.');
          if (!state.videos[resourceId.videoId]) return fail(404, 'videoNotFound', 'Video not found.');
          if (position !== undefined && !playlist.manual) return fail(400, 'manualSortRequired', 'The playlist must be sorted manually.');
          const item = newItem(resourceId.videoId);
          const at = position === undefined ? playlist.items.length : Math.min(position, playlist.items.length);
          playlist.items.splice(at, 0, item);
          return json(itemResource(playlistId, item, at));
        }

        case 'DELETE playlistItems': {
          for (const playlist of state.playlists) {
            const at = playlist.items.findIndex((item) => item.id === params.get('id'));
            if (at >= 0) {
              playlist.items.splice(at, 1);
              return new Response(null, { status: 204 });
            }
          }
          return fail(404, 'playlistItemNotFound', 'Playlist item not found.');
        }

        case 'PUT playlistItems': {
          const playlist = find(body.snippet.playlistId);
          const from = playlist ? playlist.items.findIndex((item) => item.id === body.id) : -1;
          if (from < 0) return fail(404, 'playlistItemNotFound', 'Playlist item not found.');
          if (!playlist.manual) return fail(400, 'manualSortRequired', 'The playlist must be sorted manually.');
          const [item] = playlist.items.splice(from, 1);
          const at = Math.min(body.snippet.position, playlist.items.length);
          playlist.items.splice(at, 0, item);
          return json(itemResource(playlist.id, item, at));
        }

        default:
          return fail(400, 'unsupported', `The fake API doesn't support ${method} ${path}.`);
      }
    }

    return {
      fetch,
      state,
      videosIn: (id) => (id === 'LL' ? state.liked : find(id).items).map((item) => item.videoId),
      // Changes "made on YouTube" between syncs:
      addPlaylist(id, title, videoIds = []) {
        state.playlists.push({ id, title, privacy: 'private', manual: true, items: videoIds.map(newItem) });
      },
      deletePlaylist(id) {
        state.playlists.splice(state.playlists.indexOf(find(id)), 1);
      },
      addVideo(id, videoId, position) {
        const items = id === 'LL' ? state.liked : find(id).items;
        items.splice(position ?? items.length, 0, newItem(videoId));
      },
      removeVideo(id, videoId) {
        const items = id === 'LL' ? state.liked : find(id).items;
        items.splice(items.findIndex((item) => item.videoId === videoId), 1);
      },
      moveVideo(id, from, to) {
        const items = find(id).items;
        items.splice(to, 0, ...items.splice(from, 1));
      },
      rename(id, title) {
        find(id).title = title;
      },
      renameVideo(videoId, title) {
        state.videos[videoId] = { ...state.videos[videoId], title };
      },
      /** Which playlists' entries were read (GET playlistItems), in order, from request number `from` on. */
      readsOf(from = 0) {
        return state.requests.slice(from).filter((r) => r.method === 'GET' && r.path === 'playlistItems').map((r) => r.params.playlistId);
      },
    };
  }

  globalThis.createFakeYouTube = createFakeYouTube;
  if (typeof module === 'object' && module.exports) module.exports = createFakeYouTube;
})();
