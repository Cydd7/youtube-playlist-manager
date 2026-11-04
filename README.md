# YouTube Playlist Manager

A Chrome extension that adds a dashboard to the top of your YouTube playlists page
(<https://www.youtube.com/feed/playlists>). In it you can:

- sort playlists into folders, and folders into folders
- drag and drop folders, playlists and videos, one at a time or several together
- search folders, playlists and videos, and undo or redo any edit
- pull your playlists and Liked videos from YouTube, as often as you like, without losing your folders (after the
  first pull, only the playlists that changed are read)
- push the changes you make here (videos added, removed, moved or reordered) back to your playlists on YouTube
- back everything up (the folder structure plus full video details) as one JSON file, and restore it

Your library is stored in your browser. Nothing changes on YouTube until you click **Push to YouTube** and confirm.

## Install

1. Clone or download this repository.
2. Open `chrome://extensions` and turn on **Developer mode**.
3. Click **Load unpacked** and choose the `extension` folder.
4. Open <https://www.youtube.com/feed/playlists>, or click the extension's toolbar button.

To try it without any setup, click **Import** and choose [`samples/sample-backup.json`](samples/sample-backup.json).

After changing the code, click the reload button on the extension's card in `chrome://extensions` and refresh the YouTube tab.

## Using the dashboard

| To | Do this |
|---|---|
| Add a folder | **Folder** adds one at the top level. The folder-plus button on a folder's row adds one inside it. |
| Rename a folder | Use the pencil button on its row, or double-click its name. Enter saves, Esc cancels. |
| Delete a folder | Use the bin button on its row. Whatever was inside moves up a level; no playlists or videos are deleted. |
| Open or close | Click a folder's or playlist's row. An open playlist shows its videos. |
| Move something | Drag its row. Drop on the top or bottom edge of a row to place it before or after that row. Drop on the middle of a folder to put it inside. Drop a video on a playlist to add it to the end. Drop below the last row to move to the top level. Hovering over a closed folder while dragging opens it. |
| Copy a video | Hold Alt (Option on a Mac) or Ctrl while dropping it. Videos dragged out of Liked videos are always copied. |
| Select several | Ctrl-click (⌘-click on a Mac) rows to add them, Shift-click to select a range. Drag any selected row to move them all. Videos and folders/playlists are selected separately. |
| Remove videos | Select them and press Delete, or use **Remove from playlist**. Selected folders are deleted the same way. |
| Search | Type in the search box. Folders, playlists and videos (title or channel) whose name contains every word you typed are shown; everything else is hidden. Esc clears it. |
| Undo or redo | The arrow buttons, Ctrl+Z, and Ctrl+Shift+Z or Ctrl+Y (⌘ on a Mac). Pulling, pushing and importing clear the undo history. |
| Back up | **Export** downloads `youtube-playlist-manager-backup-YYYY-MM-DD.json`. |
| Restore | **Import** a backup. The file is checked first, and you're asked before your current library is replaced. |
| Hide the folders | Click the arrow next to "YouTube Playlist Manager". |

A folder can hold folders and playlists. A playlist can hold only videos. The same video can be in several playlists.
**Liked videos** (marked with a heart) mirrors YouTube and is read-only here: you can file it in a folder and copy
videos out of it, but not add, remove or reorder its videos.

## Syncing with YouTube

**Pull from YouTube** brings in what changed on YouTube and merges it into your library:

- New playlists are added at the top level, ready to sort into folders. Playlists you've filed in folders stay there.
- Videos added to a playlist on YouTube appear in that playlist next to the same neighbours; videos removed on
  YouTube are removed here. Changes you made here and haven't pushed yet are kept.
- A playlist reordered on YouTube takes YouTube's order, unless you reordered it here too. Then your order wins,
  and Push sends it.
- Playlists deleted on YouTube are removed here, and renamed ones are renamed.
- Liked videos is replaced with what YouTube has. Deleted and private videos are kept and marked as unavailable.
- If you sign in with a different channel from the one your library came from, you're asked before anything is replaced.

A pull only reads what changed. YouTube gives each playlist a version tag, which changes when what YouTube reports
about the playlist changes: its title, privacy, number of videos or thumbnail (normally its first video). A pull
lists your playlists, which takes one request per 50, and reads only those whose tag is new, several at a time.
Liked videos is read only when its newest likes or its size changed. Details are fetched only for videos new to
your library. When nothing changed, a pull takes a few requests and a second or two.

A quick pull can miss a change that leaves a playlist's size, first video and title as they were. Examples are one
video swapped for another, or videos reordered below the first. **Shift-click Pull from YouTube** to read everything
again: every playlist, Liked videos, and fresh details for every video, including titles, view counts, and which
videos were deleted or made private. The first pull always reads everything.

**Push to YouTube** sends the changes you've made here. The button shows how many are waiting, and each changed
playlist shows a "to push" badge.

- It first reads, in full, every playlist it's about to change, plus any whose tag changed on YouTube. So changes
  made on YouTube in the meantime are merged in, never overwritten, even ones a quick pull would miss.
- It then lists every change, playlist by playlist, along with the quota it will use, and only continues when you
  confirm.
- Only playlists with changes are written to. Videos are added before they're removed, so a video moved between
  playlists is never missing from both if a push stops halfway.
- Reordering uses the fewest moves possible.
- If a push stops (for example, when the daily quota runs out), push again later to finish. Nothing is sent twice.
- Afterwards it notes the pushed playlists' new version tags, so the next pull doesn't read them again.

What it costs: reading costs 1 quota unit per 50 items. A pull with nothing new uses 3 or 4 of the 10,000 free daily
units. Reading everything (the first pull, or Shift-click) uses about 250 units for 100 playlists with 5,000 videos.
Each change you push (adding, removing or moving one video) costs 50 units, so about 200 changes fit in a day.

Not synced:

- Folders only exist here.
- Creating, renaming or deleting playlists, and changing their privacy, is done on YouTube; the next pull picks it up.
- Reordering only works on playlists whose sort order on YouTube is **Manual**. Additions to other playlists go at the
  end, and the dashboard tells you which playlists it couldn't reorder.
- Watch Later and playlists you saved from other channels aren't available through the YouTube API.
- A library made with an earlier version of this extension had no sync record. On its first pull, a video that's
  missing here but still on YouTube can't be told apart from one just added on YouTube, so it comes back.

## Set up syncing

Syncing uses the official YouTube Data API with your Google sign-in, so it needs a Google Cloud project of your own.
This is a one-time setup of about 10 minutes.

1. Open the [Google Cloud console](https://console.cloud.google.com/) and create a project (any name).
2. In **APIs & Services → Library**, find **YouTube Data API v3** and click **Enable**.
3. Set up the **OAuth consent screen** (called **Google Auth Platform** in newer versions of the console):
   - Enter an app name and your email, and choose the **External** audience.
   - Under **Audience → Test users**, add the Google account that owns your YouTube channel.
   - Under **Data Access**, add two scopes:
     - `https://www.googleapis.com/auth/youtube.readonly`, which pulls need;
     - `https://www.googleapis.com/auth/youtube`, which pushes need, because they change your playlists.
   - Leave the app in **Testing**. You don't need to publish or verify it.
4. Create an **OAuth client ID** (under **Clients**, or **Credentials → Create credentials**):
   - Application type: **Web application**.
   - Authorized redirect URI: `https://hbmgcfjjjjkdmbajfejeeabakcakcoil.chromiumapp.org/` (with the trailing slash).
5. Paste the client ID into [`extension/config.js`](extension/config.js) as `googleClientId`, then reload the
   extension in `chrome://extensions`.
6. On the playlists page, click **Pull from YouTube** and pick your account or brand channel. Google warns that it
   hasn't verified the app. It's your own app in testing mode, so choose **Continue**.

A pull only asks to read your account. The first push asks again for permission to manage your YouTube account,
because that's the permission needed to change playlists. The sign-in is reused until it expires (about an hour) and
is never written to disk.

The `key` in `manifest.json` fixes the extension's ID (`hbmgcfjjjjkdmbajfejeeabakcakcoil`), so the redirect URI is
the same wherever you load the folder from. If sign-in fails, the dashboard shows the redirect URI to check.

## Backup format

A backup is a single JSON document. The library is stored in the same shape.

```jsonc
{
  "format": "youtube-playlist-manager",
  "version": 2,
  "exportedAt": "2026-10-30T12:00:00.000Z",
  "sync": { "channelId": "UC…", "channelTitle": "…", "pulledAt": "…", "pushedAt": "…" },
  "root": ["LL", "fld_music", "PL…"],                     // top level, in display order
  "folders": {
    "fld_music": { "name": "Music", "open": true, "children": ["PL…", "fld_focus"] }
  },
  "playlists": {
    "PL…": {
      "title": "Morning run",
      "open": false,
      "items": [{ "videoId": "…", "addedAt": "2024-05-01T10:00:00Z", "itemId": "…" }],
      "synced": ["…"],                                     // its YouTube entry IDs at the last pull or push
      "syncedVersion": "…",                                // YouTube's version tag for the playlist then
      "youtube": { /* the playlist exactly as the YouTube API returned it */ }
    },
    "LL": { "title": "Liked videos", "kind": "liked", "items": [ … ], "synced": [ … ] }
  },
  "videos": {
    "…": { /* the video exactly as the YouTube API returned it: snippet, contentDetails, statistics, … */ }
  }
}
```

- The data is flat: folders, playlists and videos each live in their own map keyed by ID, and the tree only lists
  IDs. A video's details are stored once even when it's in several playlists.
- For syncing, each playlist entry keeps its YouTube ID (`itemId`). Each playlist keeps the list of entries YouTube
  had at the last pull or push (`synced`), and YouTube's version tag for it then (`syncedVersion`). Comparing that
  list with what YouTube has now and what's here is how a pull tells "added on YouTube" from "removed here", and how
  a push knows what to send. A pull skips playlists whose version tag hasn't changed.
- `version` lets newer versions read older backups. Version 1 backups, and backups made before the app was renamed
  (`"format": "playlist-manager"`), still import.
- An import is rejected, with the reasons shown, if the file breaks the rules. For example: an ID listed in two
  places, a folder inside itself, an item that isn't a folder or playlist, or a playlist entry whose video is
  missing from `videos`.

The library is saved in `chrome.storage.local`, with the `unlimitedStorage` permission because full details for a few
thousand videos exceed Chrome's default 10 MB. It's split into two keys: the structure, which is small and saved on
every change, and the video details, which are large and saved only by Import and by a pull that changed them. That
keeps dragging and syncing fast.
The data belongs to this Chrome profile; use Export and Import to move it to another computer.

## Development

There's no build step: the files in `extension/` are what Chrome loads.

| Path | What it does |
|---|---|
| `extension/manifest.json` | Manifest V3. The content scripts run on youtube.com, but the dashboard only appears on `/feed/playlists`. |
| `extension/lib/model.js` | Data model: rules, moves, copies, undo snapshots, validation, import/export. Pure JavaScript, also used by the tests. |
| `extension/lib/sync.js` | Two-way sync: what a pull needs to read, merging it, planning a push (fewest moves), and carrying it out safely. Pure JavaScript. |
| `extension/lib/youtube-api.js` | YouTube Data API client: reading the library (only what's asked, several requests at a time, with Liked videos) and adding, removing and moving entries. |
| `extension/lib/storage.js` | Loading and saving in `chrome.storage.local`, and noticing changes from other tabs. |
| `extension/background.js` | Service worker: Google sign-in and the pull and push sessions. The toolbar button opens the playlists page. |
| `extension/content/main.js` | Finds the playlists page (YouTube changes pages without reloading) and places the dashboard above the grid. |
| `extension/content/dashboard.js` | The dashboard: toolbars, search, selection, undo and the tree, rendered in a Shadow DOM so YouTube's CSS can't affect it. |
| `extension/content/dnd.js` | Drag and drop: which drops are allowed and where they land. |
| `extension/content/sync.js` | The Pull and Push buttons: progress and the questions asked before changes. |
| `extension/content/dom.js`, `styles.js` | Element and icon helpers, and the dashboard's CSS. The UI is built without `innerHTML` because YouTube enforces Trusted Types. |
| `tests/support/fake-youtube.js` | An in-memory YouTube Data API used by the unit and end-to-end tests. |

Tests:

```bash
npm test
```

```bash
npm run test:e2e
```

`npm test` runs the unit tests (model, sync, drag-and-drop rules, API client) with Node's built-in test runner. The
sync tests pull from and push to the fake YouTube API, including quota running out halfway and playlists that
aren't sorted manually, and check which playlists each pull and push reads. The fake's version tags only change
when a playlist's title, privacy, size or first video does, so the tests can't rely on YouTube reporting more. `npm run test:e2e` loads the extension into Chromium and drives the dashboard on a stand-in
YouTube page, with Google sign-in stubbed and the fake YouTube API running in the extension's service worker. It needs
Playwright first:

```bash
npm i -D playwright && npx playwright install chromium
```
