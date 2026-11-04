const test = require('node:test');
const assert = require('node:assert/strict');

const M = require('../../extension/lib/model.js');
const S = require('../../extension/lib/sync.js');
const { client } = require('../../extension/lib/youtube-api.js');
const createFakeYouTube = require('../support/fake-youtube.js');

const titles = (...ids) => Object.fromEntries(ids.map((id) => [id, { title: `Title ${id}` }]));
const ids = (doc, id) => doc.playlists[id].items.map((item) => item.videoId);
const writes = (yt, from) => yt.state.calls.slice(from).filter((call) => !call.startsWith('GET'));

/** A fake YouTube with three playlists and Liked videos, plus pull and push run the way background.js runs them. */
function setup(options = {}) {
  const yt = createFakeYouTube({
    playlists: [
      { id: 'PLrun', title: 'Run', videos: ['a', 'b', 'c'] },
      { id: 'PLwork', title: 'Work', videos: ['d', 'e'] },
      { id: 'PLcook', title: 'Cook', videos: ['f', 'gone'] },
    ],
    liked: ['a', 'x'],
    videos: titles('a', 'b', 'c', 'd', 'e', 'f', 'x', 'y', 'z'),
    ...options,
  });
  const api = (token) => client({ token, fetch: yt.fetch, sleep: async () => {} });
  const read = async (youtube, doc, options) => {
    const remote = await youtube.fetchLibrary(await youtube.fetchChannel(), S.readOptions(doc, options));
    return { remote, summary: S.merge(doc, remote) };
  };
  const pull = async (doc, { full = false } = {}) => (await read(api('read-token'), doc, { full })).summary;
  const execute = (doc, plan, writer = api('write-token')) =>
    S.executePush(doc, plan, { insert: writer.insertItem, remove: writer.deleteItem, move: writer.moveItem });
  const push = async (doc) => {
    const writer = api('write-token');
    const { remote } = await read(writer, doc, { targets: S.planPush(doc).playlists.map((p) => p.id) });
    const plan = S.planPush(doc, Object.keys(remote.items));
    const pushed = plan.playlists.map((p) => p.id);
    S.forgetVersions(doc, pushed);
    const result = await execute(doc, plan, writer);
    if (!result.stopped) S.recordVersions(doc, pushed, await writer.fetchPlaylists());
    return { plan, result };
  };
  return { yt, pull, push, execute };
}

test('the first pull brings in every playlist, Liked videos and all video details', async () => {
  const { pull } = setup();
  const doc = M.emptyDoc();
  const summary = await pull(doc);

  assert.deepEqual(doc.root, ['LL', 'PLrun', 'PLwork', 'PLcook']);
  assert.equal(doc.playlists.LL.kind, 'liked');
  assert.equal(doc.playlists.LL.title, 'Liked videos');
  assert.deepEqual(ids(doc, 'LL'), ['a', 'x']);
  assert.deepEqual(ids(doc, 'PLcook'), ['f', 'gone']);
  assert.equal(doc.videos.a.snippet.title, 'Title a');
  assert.deepEqual(doc.videos.gone, { id: 'gone', unavailable: true, snippet: { title: 'Deleted video' }, status: { privacyStatus: 'privacyStatusUnspecified' } });
  assert.deepEqual(doc.playlists.PLrun.synced, doc.playlists.PLrun.items.map((item) => item.itemId));
  assert.equal(doc.playlists.PLrun.syncedVersion, 'v:Run|private|3|a', "YouTube's version tag for the playlist");
  assert.equal(doc.playlists.LL.syncedVersion, '2', 'for Liked videos, its size');
  assert.equal(doc.sync.channelId, 'UCfakechannel');
  assert.deepEqual(M.validate(doc), []);
  assert.equal(S.pending(doc).total, 0);
  assert.equal(summary.read, 3);
  assert.equal(summary.videosChanged, true);
  assert.match(S.describePull(summary).text, /^Pulled 3 playlists with 7 videos, plus 2 liked videos\. Everything is at the top level/);
});

test('a pull only reads the playlists that changed on YouTube, and only describes new videos', async () => {
  const { yt, pull } = setup();
  const doc = M.emptyDoc();
  await pull(doc);

  let from = yt.state.requests.length;
  const unchanged = await pull(doc);
  assert.deepEqual(yt.state.requests.slice(from).map((r) => r.path), ['channels', 'playlists', 'playlistItems'],
    'the channel, the list of playlists, and the first page of Liked videos to see that it is unchanged');
  assert.deepEqual(yt.readsOf(from), ['LL']);
  assert.equal(unchanged.read, 0);
  assert.equal(unchanged.videosChanged, false, 'so the video details are not saved again');
  assert.deepEqual(S.describePull(unchanged), { kind: 'success', text: 'Already up to date with YouTube.' });

  yt.addVideo('PLwork', 'y');
  yt.rename('PLcook', 'Cooking');
  from = yt.state.requests.length;
  const summary = await pull(doc);
  assert.deepEqual(yt.readsOf(from), ['PLwork', 'PLcook', 'LL']);
  assert.deepEqual(yt.state.requests.slice(from).filter((r) => r.path === 'videos').map((r) => r.params.id), ['y'],
    'only the new video is described');
  assert.deepEqual(ids(doc, 'PLwork'), ['d', 'e', 'y']);
  assert.equal(doc.playlists.PLcook.title, 'Cooking');
  assert.equal(summary.read, 2);
  assert.equal(summary.videosChanged, true);
  assert.deepEqual(M.validate(doc), []);
});

test('Liked videos is read again only when its first page or its size changed', async () => {
  const { yt, pull } = setup({ liked: ['a', 'b', 'c', 'd', 'e'], pageSize: 2 });
  const doc = M.emptyDoc();
  await pull(doc);
  const likedReads = (from) => yt.readsOf(from).filter((id) => id === 'LL').length;

  let from = yt.state.requests.length;
  await pull(doc);
  assert.equal(likedReads(from), 1, 'unchanged: only its first page');

  yt.addVideo('LL', 'x', 0);
  from = yt.state.requests.length;
  await pull(doc);
  assert.equal(likedReads(from), 3, 'a new like is at the top: read all 3 pages');
  assert.deepEqual(ids(doc, 'LL'), ['x', 'a', 'b', 'c', 'd', 'e']);

  yt.removeVideo('LL', 'e');
  from = yt.state.requests.length;
  await pull(doc);
  assert.equal(likedReads(from), 3, 'an unlike further down changes the size');
  assert.deepEqual(ids(doc, 'LL'), ['x', 'a', 'b', 'c', 'd']);
});

test('a pull misses a swap YouTube does not report; a full pull finds it and describes every video again', async () => {
  const { yt, pull } = setup();
  const doc = M.emptyDoc();
  await pull(doc);
  yt.removeVideo('PLrun', 'c');
  yt.addVideo('PLrun', 'y'); // Run: a b y. The same size and first video, so the same version tag.
  yt.renameVideo('a', 'Title a, renamed');

  await pull(doc);
  assert.deepEqual(ids(doc, 'PLrun'), ['a', 'b', 'c']);
  assert.equal(doc.videos.a.snippet.title, 'Title a');

  const summary = await pull(doc, { full: true });
  assert.equal(summary.read, 3);
  assert.deepEqual(ids(doc, 'PLrun'), ['a', 'b', 'y']);
  assert.equal(doc.videos.a.snippet.title, 'Title a, renamed');
  assert.deepEqual(M.validate(doc), []);
});

test('a reorder on YouTube is taken over when the order here is unchanged', async () => {
  const { yt, pull } = setup();
  const doc = M.emptyDoc();
  await pull(doc);
  M.moveVideos(doc, [{ playlist: 'LL', index: 1 }], 'PLrun', 0); // here: Run = x a b c (x copied from Liked)
  yt.moveVideo('PLrun', 2, 0); // YouTube: Run = c a b

  const summary = await pull(doc);
  assert.deepEqual(ids(doc, 'PLrun'), ['x', 'c', 'a', 'b'], "YouTube's order; x keeps its place");
  assert.equal(S.pending(doc).total, 1, 'only adding x is waiting, not undoing the reorder');
  assert.deepEqual(S.describePull(summary, 1).details, ['“Run”: reordered on YouTube']);
});

test('when both sides reordered a playlist, the order here wins', async () => {
  const { yt, pull, push } = setup();
  const doc = M.emptyDoc();
  await pull(doc);
  M.moveVideo(doc, 'PLrun', 0, 'PLrun'); // here: Run = b c a
  yt.moveVideo('PLrun', 2, 0); // YouTube: Run = c a b

  await pull(doc);
  assert.deepEqual(ids(doc, 'PLrun'), ['b', 'c', 'a']);
  await push(doc);
  assert.deepEqual(yt.videosIn('PLrun'), ['b', 'c', 'a']);
});

test('pulling again merges YouTube changes into your folders and keeps changes made here', async () => {
  const { yt, pull } = setup();
  const doc = M.emptyDoc();
  await pull(doc);
  const sport = M.addFolder(doc, M.ROOT, 'Sport');
  M.moveNode(doc, 'PLrun', sport);
  M.moveVideo(doc, 'PLwork', 0, 'PLrun', 0); // here: Run = d a b c, Work = e

  // Meanwhile, on YouTube:
  yt.addVideo('PLrun', 'y', 1); // Run = a y b c
  yt.removeVideo('PLrun', 'c'); // Run = a y b
  yt.addVideo('PLrun', 'z'); // Run = a y b z
  yt.addPlaylist('PLnew', 'New one', ['z']);
  yt.deletePlaylist('PLcook');
  yt.rename('PLwork', 'Work stuff');
  yt.addVideo('LL', 'y', 0);

  const summary = await pull(doc);
  assert.deepEqual(doc.folders[sport].children, ['PLrun'], 'the playlist stays in its folder');
  assert.deepEqual(ids(doc, 'PLrun'), ['d', 'a', 'y', 'b', 'z'], 'y lands after a, z at the end, c is gone, d (moved here) stays');
  assert.deepEqual(ids(doc, 'PLwork'), ['e'], 'd stays moved away');
  assert.equal(doc.playlists.PLwork.title, 'Work stuff');
  assert.deepEqual(doc.root, ['LL', 'PLwork', sport, 'PLnew']);
  assert.equal(M.isPlaylist(doc, 'PLcook'), false);
  assert.deepEqual(ids(doc, 'LL'), ['y', 'a', 'x']);
  assert.equal(doc.videos.gone, undefined, 'details nothing uses any more are dropped');
  assert.deepEqual(M.validate(doc), []);

  const waiting = S.pending(doc).total;
  assert.equal(waiting, 2, 'add d to Run, remove it from Work');
  assert.deepEqual(S.describePull(summary, waiting), {
    kind: 'success',
    text: "Pulled the latest from YouTube. 2 changes made here aren't on YouTube yet; Push to send them.",
    details: [
      'New playlist “New one” (1 video), added at the top level',
      '“Run”: 2 new videos, 1 removed on YouTube',
      '“Work” was renamed to “Work stuff” on YouTube',
      '“Cook” was deleted on YouTube, so it was removed here',
    ],
  });
});

test('pushing adds, removes and reorders on YouTube, adding before removing', async () => {
  const { yt, pull, push } = setup();
  const doc = M.emptyDoc();
  await pull(doc);
  M.moveVideo(doc, 'PLwork', 0, 'PLrun', 1); // Run = a d b c, Work = e
  M.moveVideo(doc, 'PLrun', 3, 'PLrun', 0); // Run = c a d b
  M.removeVideos(doc, [{ playlist: 'PLcook', index: 1 }]); // Cook = f
  M.moveVideos(doc, [{ playlist: 'LL', index: 1 }], 'PLcook', 0); // Cook = x f (copied from Liked)
  assert.deepEqual(ids(doc, 'LL'), ['a', 'x']);

  const plan = S.planPush(doc);
  assert.deepEqual(S.describePlan(plan), {
    text: 'Push 5 changes to YouTube? This uses about 250 of your 10,000 daily API units.',
    details: ['“Run”: add 1 video, reorder (1 move)', '“Work”: remove 1 video', '“Cook”: add 1 video, remove 1 video'],
    confirm: 'Push 5 changes',
  });

  const callsBefore = yt.state.calls.length;
  const requestsBefore = yt.state.requests.length;
  const { result } = await push(doc);
  assert.deepEqual(yt.readsOf(requestsBefore), ['PLrun', 'PLwork', 'PLcook', 'LL'],
    'the playlists about to change are read first; Liked videos is only checked');
  assert.deepEqual(writes(yt, callsBefore), [
    'POST playlistItems', 'POST playlistItems', 'DELETE playlistItems', 'DELETE playlistItems', 'PUT playlistItems',
  ]);
  assert.deepEqual(yt.videosIn('PLrun'), ['c', 'a', 'd', 'b']);
  assert.deepEqual(yt.videosIn('PLwork'), ['e']);
  assert.deepEqual(yt.videosIn('PLcook'), ['x', 'f']);
  assert.deepEqual(yt.videosIn('LL'), ['a', 'x'], 'Liked videos is never changed');
  assert.deepEqual(S.describePush(result), { kind: 'success', text: 'Pushed 5 changes to YouTube.' });
  assert.equal(S.pending(doc).total, 0);
  assert.equal(doc.playlists.PLrun.syncedVersion, 'v:Run|private|4|c', "the pushed playlists' new versions are known");

  // Everything here now matches YouTube, so the next pull reads no playlist and changes nothing.
  const entries = () => JSON.stringify(Object.values(doc.playlists).map((p) => [p.items, p.synced]));
  const before = entries();
  const from = yt.state.requests.length;
  await pull(doc);
  assert.deepEqual(yt.readsOf(from), ['LL']);
  assert.equal(entries(), before);
});

test('a push reads the playlists it changes first, even when YouTube reports them unchanged', async () => {
  const { yt, pull, push } = setup();
  const doc = M.emptyDoc();
  await pull(doc);
  yt.removeVideo('PLrun', 'c');
  yt.addVideo('PLrun', 'y'); // YouTube: Run = a b y, with the same version tag
  M.removeVideos(doc, [{ playlist: 'PLrun', index: 1 }]); // here: Run = a c

  const from = yt.state.requests.length;
  const { plan } = await push(doc);
  assert.deepEqual(yt.readsOf(from), ['PLrun', 'LL']);
  assert.equal(plan.total, 1, 'remove b');
  assert.deepEqual(yt.videosIn('PLrun'), ['a', 'y']);
  assert.deepEqual(ids(doc, 'PLrun'), ['a', 'y'], 'c went and y came, as on YouTube');
  assert.equal(S.pending(doc).total, 0);
});

test('after a push, a playlist is only given its new version if its size is what the push left', () => {
  const doc = M.emptyDoc();
  doc.playlists.P = { title: 'P', items: [], synced: ['i1', 'i2'], syncedVersion: 'old' };
  doc.root.push('P');
  S.forgetVersions(doc, ['P']);
  assert.equal(doc.playlists.P.syncedVersion, undefined);

  S.recordVersions(doc, ['P'], [{ id: 'P', etag: 'v3', snippet: { title: 'P' }, contentDetails: { itemCount: 3 } }]);
  assert.equal(doc.playlists.P.syncedVersion, undefined, 'it was changed elsewhere too: the next pull reads it');
  S.recordVersions(doc, ['P'], [{ id: 'P', etag: 'v2', snippet: { title: 'P' }, contentDetails: { itemCount: 2 } }]);
  assert.equal(doc.playlists.P.syncedVersion, 'v2');
});

test('playlists not sorted manually get additions at the end and are reported, not reordered', async () => {
  const { yt, pull, push } = setup({
    playlists: [
      { id: 'PLauto', title: 'Auto', videos: ['a', 'b'], manual: false },
      { id: 'PLsrc', title: 'Source', videos: ['c'] },
    ],
    liked: [],
  });
  const doc = M.emptyDoc();
  await pull(doc);
  M.moveVideos(doc, [{ playlist: 'PLsrc', index: 0 }], 'PLauto', 0, { copy: true }); // Auto = c a b
  M.moveVideo(doc, 'PLauto', 2, 'PLauto', 1); // Auto = c b a

  const { result } = await push(doc);
  assert.deepEqual(yt.videosIn('PLauto'), ['a', 'b', 'c']);
  assert.deepEqual(result.unordered, ['Auto']);
  const message = S.describePush(result);
  assert.equal(message.kind, 'error');
  assert.match(message.details[0], /“Auto” couldn't be reordered because it isn't sorted manually on YouTube/);
  assert.ok(S.pending(doc).total > 0, 'the order is still waiting to be pushed');
});

test('a push that runs out of quota stops cleanly and the next push finishes without repeating anything', async () => {
  const { yt, pull, push, execute } = setup();
  const doc = M.emptyDoc();
  await pull(doc);
  M.moveVideos(doc, [0, 1, 2].map((index) => ({ playlist: 'PLrun', index })), 'PLwork'); // 3 adds + 3 removals

  yt.state.quota = yt.state.used + 4 * 50;
  const plan = S.planPush(doc);
  const first = { plan, result: await execute(doc, plan) };
  assert.equal(first.plan.total, 6);
  assert.equal(first.result.done, 4);
  assert.match(S.describePush(first.result).text, /^Pushed 4 of 6 changes, then stopped: Today's YouTube API quota is used up/);
  assert.deepEqual(yt.videosIn('PLwork'), ['d', 'e', 'a', 'b', 'c']);

  yt.state.quota = Infinity;
  const second = await push(doc);
  assert.equal(second.plan.total, 2);
  assert.equal(second.result.done, 2);
  assert.deepEqual(yt.videosIn('PLwork'), ['d', 'e', 'a', 'b', 'c']);
  assert.deepEqual(yt.videosIn('PLrun'), []);
});

test('a change YouTube refuses is reported and the rest still happens', async () => {
  const { yt, pull, push } = setup();
  const doc = M.emptyDoc();
  await pull(doc);
  M.moveVideos(doc, [{ playlist: 'PLcook', index: 1 }], 'PLwork', 0, { copy: true }); // "gone" no longer exists
  M.moveVideo(doc, 'PLrun', 0, 'PLrun'); // Run = b c a

  const { result } = await push(doc);
  assert.deepEqual(result.failed, ['“Work”: couldn\'t add “Deleted video” (the video no longer exists or is private)']);
  assert.deepEqual(yt.videosIn('PLrun'), ['b', 'c', 'a']);
  assert.deepEqual(yt.videosIn('PLwork'), ['d', 'e']);
  assert.equal(S.pending(doc).total, 1, 'the failed addition is still waiting');
});

test('pushing needs write access', async () => {
  const { yt, pull } = setup();
  const doc = M.emptyDoc();
  await pull(doc);
  M.moveVideo(doc, 'PLrun', 0, 'PLwork');
  const reader = client({ token: 'read-token', fetch: yt.fetch, sleep: async () => {} });
  const result = await S.executePush(doc, S.planPush(doc), { insert: reader.insertItem, remove: reader.deleteItem, move: reader.moveItem });
  assert.equal(result.done, 0);
  assert.match(result.stopped.message, /didn't grant the access this needs/);
});

test('the first sync of a library made before sync existed matches entries by video', async () => {
  const { yt, pull } = setup();
  const doc = M.emptyDoc();
  await pull(doc);
  for (const playlist of Object.values(doc.playlists)) {
    delete playlist.synced;
    playlist.items = playlist.items.map(({ videoId }) => ({ videoId }));
  }
  delete doc.sync;
  M.moveVideo(doc, 'PLwork', 1, 'PLrun'); // here: Run = a b c e, Work = d
  yt.addVideo('PLwork', 'z'); // YouTube: Work = d e z

  await pull(doc);
  assert.deepEqual(ids(doc, 'PLrun'), ['a', 'b', 'c', 'e']);
  // With no record of the last sync, "e is missing here" can't be told apart from
  // "e was added on YouTube", so it comes back rather than risk deleting it on YouTube.
  assert.deepEqual(ids(doc, 'PLwork'), ['d', 'e', 'z']);
  assert.equal(S.pending(doc).total, 1, 'only adding e to Run is waiting');
});

test('libraryChannel finds the channel from the sync record or the playlists', () => {
  assert.equal(S.libraryChannel(M.emptyDoc()), null);
  const doc = M.emptyDoc();
  doc.playlists.P = { title: 'P', items: [], youtube: { snippet: { channelId: 'UCold', channelTitle: 'Old' } } };
  assert.deepEqual(S.libraryChannel(doc), { id: 'UCold', title: 'Old' });
  doc.sync = { channelId: 'UCnew', channelTitle: 'New' };
  assert.deepEqual(S.libraryChannel(doc), { id: 'UCnew', title: 'New' });
});

test('reorderMoves always finds the fewest moves', () => {
  const lisLength = (seq) => {
    const best = seq.map(() => 1);
    for (let i = 0; i < seq.length; i++) for (let j = 0; j < i; j++) if (seq[j] < seq[i]) best[i] = Math.max(best[i], best[j] + 1);
    return seq.length ? Math.max(...best) : 0;
  };
  const shuffle = (list) => {
    const out = [...list];
    for (let i = out.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
  };
  for (let run = 0; run < 300; run++) {
    const tokens = Array.from({ length: run % 13 }, (_, i) => `t${i}`);
    const current = shuffle(tokens);
    const target = shuffle(tokens);
    const moves = S.reorderMoves(current, target);
    const list = [...current];
    for (const { token, position } of moves) {
      list.splice(list.indexOf(token), 1);
      list.splice(position, 0, token);
    }
    assert.deepEqual(list, target);
    assert.equal(moves.length, tokens.length - lisLength(target.map((t) => current.indexOf(t))));
  }
});
