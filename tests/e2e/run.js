/*
 * End-to-end test: loads the real extension into Chromium and drives the
 * dashboard on a stand-in YouTube page (every youtube.com request is answered
 * with mock-youtube.html, served with Trusted Types enforced like YouTube).
 * For syncing, Google sign-in is stubbed and the fake YouTube API from
 * tests/support runs inside the extension's service worker.
 *
 *   npm run test:e2e              (needs: npm i -D playwright && npx playwright install chromium)
 *   SCREENSHOTS=dir npm run test:e2e   also saves screenshots of the dashboard
 */
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const M = require('../../extension/lib/model.js');

const EXTENSION = path.resolve(__dirname, '../../extension');
const SAMPLE = path.resolve(__dirname, '../../samples/sample-backup.json');
const MOCK_PAGE = fs.readFileSync(path.join(__dirname, 'mock-youtube.html'), 'utf8');
const FAKE_YOUTUBE = fs.readFileSync(path.join(__dirname, '../support/fake-youtube.js'), 'utf8');
const EXTENSION_ID = 'hbmgcfjjjjkdmbajfejeeabakcakcoil';
const PIXEL = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
const HOST = '#youtube-playlist-manager';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-e2e-'));
const screenshotDir = process.env.SCREENSHOTS;

let context;
let page;
let worker;
let acceptDialogs = true;
const dialogs = [];

// --- helpers -------------------------------------------------------------------

const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const exact = (text) => new RegExp(`^${escape(text)}$`);
const button = (label) => page.locator(`${HOST} .pm-btn`, { hasText: new RegExp(`^${escape(label)}`) });
const statusButton = (label) => page.locator(`${HOST} .pm-status-actions .pm-btn`, { hasText: exact(label) });
const row = (name, p = page) => p.locator(`${HOST} .pm-row`).filter({ has: p.locator('.pm-name, .pm-link', { hasText: exact(name) }) });
const playlistRow = (id) => page.locator(`${HOST} .pm-row[data-kind="playlist"][data-id="${id}"]`);
const videoIn = (playlistId, title) => page.locator(`${HOST} .pm-row[data-kind="video"][data-playlist="${playlistId}"][data-label="${title}"]`);
const storage = () => worker.evaluate(() => chrome.storage.local.get(null));
const onYouTube = (playlistId) => worker.evaluate((id) => self.fakeYouTube.videosIn(id), playlistId);
const requestCount = () => worker.evaluate(() => self.fakeYouTube.state.requests.length);
/** Which playlists' entries the fake YouTube was asked for since request number `from`. */
const readsSince = (from) => worker.evaluate((n) => self.fakeYouTube.readsOf(n), from);

/**
 * The visible tree as text: "F-" open folder, "F+" closed folder, "P-"/"P+"
 * playlists, "V" video, "E" empty placeholder; two spaces per level.
 */
function tree(p = page) {
  return p.evaluate(() => {
    const root = document.querySelector('#youtube-playlist-manager')?.shadowRoot;
    if (!root) return null;
    return [...root.querySelectorAll('.pm-row')].map((r) => {
      const depth = Number(r.style.getPropertyValue('--depth'));
      const { kind, open } = r.dataset;
      const name = r.querySelector('.pm-name, .pm-link')?.textContent ?? r.querySelector('.pm-rename')?.value ?? '';
      const mark = kind === 'video' ? 'V' : kind === 'empty' ? 'E' : `${kind[0].toUpperCase()}${open === 'true' ? '-' : '+'}`;
      return `${'  '.repeat(depth)}${mark}${name ? ` ${name}` : ''}`;
    });
  });
}

async function waitFor(check, description, timeout = 5000) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    last = await check();
    if (last) return last;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`Timed out waiting for ${description} (last value: ${JSON.stringify(last)})`);
}

async function statusText() {
  const status = page.locator(`${HOST} .pm-status-text`);
  return (await status.count()) ? status.innerText() : '';
}

async function expectStatus(pattern, timeout) {
  await waitFor(async () => pattern.test(await statusText()), `status ${pattern}`, timeout)
    .catch(async (err) => {
      throw new Error(`${err.message}\nstatus: ${JSON.stringify(await statusText())}`);
    });
}

async function expectTree(expected, p = page) {
  await waitFor(async () => JSON.stringify(await tree(p)) === JSON.stringify(expected), `tree ${JSON.stringify(expected)}`)
    .catch(async (err) => {
      throw new Error(`${err.message}\nactual: ${JSON.stringify(await tree(p), null, 1)}`);
    });
}

async function chooseFile(file) {
  const chooser = page.waitForEvent('filechooser');
  await button('Import').click();
  await (await chooser).setFiles(file);
}

async function shot(name) {
  if (!screenshotDir) return;
  fs.mkdirSync(screenshotDir, { recursive: true });
  await page.locator(HOST).screenshot({ path: path.join(screenshotDir, `${name}.png`) });
}

const steps = [];
const step = (name, fn) => steps.push({ name, fn });

// --- the dashboard on its own -----------------------------------------------------

step('the extension loads with its pinned ID', async () => {
  assert.equal(new URL(worker.url()).host, EXTENSION_ID);
});

step('shows nothing on other YouTube pages', async () => {
  await page.goto('https://www.youtube.com/');
  await page.waitForTimeout(1200);
  assert.equal(await page.locator(HOST).count(), 0);
});

step('appears above the playlist grid after in-app navigation to Playlists', async () => {
  await page.click('nav a[href="/feed/playlists"]');
  await page.locator(`${HOST} .pm-empty`).waitFor();
  const placement = await page.evaluate(() => {
    const host = document.querySelector('#youtube-playlist-manager');
    return [host.parentElement.id, host.closest('ytd-browse').id, host.nextElementSibling.tagName];
  });
  assert.deepEqual(placement, ['primary', 'playlists', 'YTD-RICH-GRID-RENDERER']);
});

step('imports a backup into the empty library', async () => {
  await chooseFile(SAMPLE);
  await expectStatus(/Imported 3 folders, 5 playlists and 12 videos/);
  await expectTree(['F- Music', '  P+ Morning run', '  F+ Focus', 'F+ Learning', 'P+ Cooking ideas', 'P+ Watch someday']);
  const stored = await waitFor(async () => {
    const s = await storage();
    return s['pm.structure']?.root?.length === 4 && s;
  }, 'imported data in storage');
  assert.equal(Object.keys(stored['pm.videos']).length, 11);
  assert.equal(stored['pm.structure'].videos, undefined, 'videos are stored under their own key');
  await shot('1-imported');
});

step('adds a folder and names it without triggering YouTube shortcuts', async () => {
  await button('Folder').click();
  const input = page.locator(`${HOST} .pm-rename`);
  await input.waitFor();
  assert.equal(await input.evaluate((el) => el.getRootNode().activeElement === el), true, 'the name box is focused');
  await page.keyboard.press('Control+A');
  await page.keyboard.type('Road/trips');
  await page.keyboard.press('Enter');
  assert.equal(await page.evaluate(() => window.shortcutFired), false, 'YouTube\'s "/" shortcut did not fire');
  await expectTree(['F- Music', '  P+ Morning run', '  F+ Focus', 'F+ Learning', 'P+ Cooking ideas', 'P+ Watch someday', 'F- Road/trips', '  E']);
});

step('renames a folder with the pencil button, and Escape cancels', async () => {
  await row('Learning').hover();
  await row('Learning').locator('[data-action="rename"]').click();
  const input = page.locator(`${HOST} .pm-rename`);
  await input.fill('Study');
  await input.press('Enter');
  await waitFor(async () => (await tree()).includes('F+ Study'), 'renamed folder');

  await row('Study').hover();
  await row('Study').locator('[data-action="rename"]').click();
  await input.fill('Nope');
  await input.press('Escape');
  await waitFor(async () => (await tree()).includes('F+ Study'), 'unchanged name');
});

step('renames a folder by double-clicking its name, without toggling it', async () => {
  await row('Study').locator('.pm-name').dblclick();
  const input = page.locator(`${HOST} .pm-rename`);
  await input.fill('Learning');
  await input.press('Enter');
  await waitFor(async () => (await tree()).includes('F+ Learning'), 'renamed, still closed');
});

step('opens and closes folders and playlists', async () => {
  await row('Learning').locator('.pm-name').click();
  await waitFor(async () => (await tree()).includes('  P+ JavaScript talks'), 'folder opened');
  await row('JavaScript talks').locator('.pm-name').click();
  await waitFor(async () => (await tree()).includes('    V Sample: Async JavaScript explained'), 'playlist opened');
  await row('Learning').locator('.pm-twisty').click();
  await waitFor(async () => !(await tree()).includes('  P- JavaScript talks'), 'folder closed');
});

step('drags a playlist into a folder', async () => {
  await row('Cooking ideas').dragTo(row('Road/trips'));
  await expectTree(['F- Music', '  P+ Morning run', '  F+ Focus', 'F+ Learning', 'P+ Watch someday', 'F- Road/trips', '  P+ Cooking ideas']);
});

step('reorders by dropping above a row', async () => {
  await row('Watch someday').dragTo(row('Music'), { targetPosition: { x: 60, y: 3 } });
  await expectTree(['P+ Watch someday', 'F- Music', '  P+ Morning run', '  F+ Focus', 'F+ Learning', 'F- Road/trips', '  P+ Cooking ideas']);
});

step('refuses to put a folder inside its own subfolder', async () => {
  const before = await tree();
  await row('Music').dragTo(row('Focus'));
  await page.waitForTimeout(300);
  assert.deepEqual(await tree(), before);
});

step('moves a video to another playlist and reorders videos', async () => {
  await row('Morning run').locator('.pm-name').click();
  await row('Cooking ideas').locator('.pm-name').click();
  await row('Sample: Weeknight pasta').dragTo(row('Sample: Tempo run playlist'), { targetPosition: { x: 200, y: 4 } });
  await row('Sample: Cool-down stretches').dragTo(row('Sample: Easy 5 km warm-up mix'), { targetPosition: { x: 200, y: 4 } });
  await expectTree([
    'P+ Watch someday',
    'F- Music',
    '  P- Morning run',
    '    V Sample: Cool-down stretches',
    '    V Sample: Easy 5 km warm-up mix',
    '    V Sample: Weeknight pasta',
    '    V Sample: Tempo run playlist',
    '  F+ Focus',
    'F+ Learning',
    'F- Road/trips',
    '  P- Cooking ideas',
    '    V Sample: Bread from scratch',
    '    V Deleted video',
  ]);
});

step('drops a video onto a closed playlist', async () => {
  await row('Sample: Bread from scratch').dragTo(row('Watch someday'));
  await waitFor(async () => {
    const t = await tree();
    return t[0] === 'P- Watch someday' && t[1] === '  V Sample: Bread from scratch';
  }, 'video appended to Watch someday, which opens');
  await row('Watch someday').locator('.pm-twisty').click();
});

step('opens a closed folder while you hover over it during a drag', async () => {
  const focus = row('Focus');
  await row('Watch someday').hover();
  await page.mouse.down();
  const box = await focus.boundingBox();
  await page.mouse.move(box.x + 80, box.y + box.height / 2, { steps: 6 });
  // Real browsers repeat dragover while the pointer rests; Playwright only sends one per move, so nudge it.
  await page.mouse.move(box.x + 82, box.y + box.height / 2, { steps: 2 });
  await waitFor(async () => (await tree()).includes('    P+ Deep work'), 'Focus opened during the drag', 3000);
  await page.mouse.move(box.x + 84, box.y + box.height / 2, { steps: 2 });
  await page.mouse.up();
  await waitFor(async () => {
    const t = await tree();
    return t.includes('  F- Focus') && t.indexOf('    P+ Deep work') + 1 === t.indexOf('    P+ Watch someday');
  }, 'Watch someday dropped into Focus');
});

step('deletes a folder, keeps what was inside, and can undo and redo it', async () => {
  const before = await tree();
  await row('Road/trips').hover();
  await row('Road/trips').locator('[data-action="delete"]').click();
  await waitFor(async () => !(await tree()).some((r) => r.includes('Road/trips')), 'folder deleted');
  await expectStatus(/^Deleted “Road\/trips”\. The 1 item inside moved to the top level\./);
  assert.deepEqual((await tree()).slice(-3), ['F+ Learning', 'P- Cooking ideas', '  V Deleted video']);

  await statusButton('Undo').click();
  await expectTree(before);
  await expectStatus(/^Undone: Delete folder\./);
  await page.locator(`${HOST} .pm-tree`).focus();
  await page.keyboard.press('Control+Shift+Z');
  await waitFor(async () => !(await tree()).some((r) => r.includes('Road/trips')), 'deleted again');
  await shot('2-organized');
});

step('searches folders, playlists and videos', async () => {
  const before = await tree();
  const search = page.locator(`${HOST} .pm-search-input`);
  await search.fill('pasta');
  await expectTree(['F- Music', '  P- Morning run', '    V Sample: Weeknight pasta']);
  assert.equal(await page.locator(`${HOST} .pm-summary`).innerText(), '1 match');
  assert.equal(await videoIn('PLsample0000000001', 'Sample: Weeknight pasta').locator('mark').innerText(), 'pasta');

  await search.fill('pasta weeknight');
  await expectTree(['F- Music', '  P- Morning run', '    V Sample: Weeknight pasta']);
  // A playlist whose name matches is shown with everything in it.
  await search.fill('cooking');
  await expectTree(['P- Cooking ideas', '  V Deleted video']);
  assert.equal(await page.locator(`${HOST} .pm-summary`).innerText(), '1 match');
  await search.fill('nothing like this');
  await waitFor(async () => (await page.locator(`${HOST} .pm-empty`).innerText()) === 'No matches for “nothing like this”.', 'no matches');
  await search.press('Escape');
  await expectTree(before);
});

step('selects several videos with Ctrl-click and drags them together; undo puts them back', async () => {
  const before = await tree();
  await row('Sample: Cool-down stretches').locator('.pm-index').click({ modifiers: ['Control'] });
  await row('Sample: Tempo run playlist').locator('.pm-index').click({ modifiers: ['Control'] });
  assert.equal(await page.locator(`${HOST} .pm-selection-count`).innerText(), '2 videos selected');
  assert.doesNotMatch(await page.locator(`${HOST} .pm-tools`).innerText(), /\bnull\b|undefined/);
  await row('Sample: Tempo run playlist').dragTo(row('Cooking ideas'));
  const moved = [
    'F- Music',
    '  P- Morning run',
    '    V Sample: Easy 5 km warm-up mix',
    '    V Sample: Weeknight pasta',
    '  F- Focus',
    '    P+ Deep work',
    '    P+ Watch someday',
    'F+ Learning',
    'P- Cooking ideas',
    '  V Deleted video',
    '  V Sample: Cool-down stretches',
    '  V Sample: Tempo run playlist',
  ];
  await expectTree(moved);
  assert.equal(await page.locator(`${HOST} .pm-row.pm-selected`).count(), 2, 'the moved videos stay selected');

  await page.keyboard.press('Control+Z');
  await expectTree(before);
  await page.keyboard.press('Control+Y');
  await expectTree(moved);
});

step('selects a range with Shift-click and removes it with Delete, then undoes', async () => {
  const before = await tree();
  await row('Deleted video').locator('.pm-index').click();
  await row('Sample: Tempo run playlist').locator('.pm-index').click({ modifiers: ['Shift'] });
  assert.equal(await page.locator(`${HOST} .pm-selection-count`).innerText(), '3 videos selected');
  await page.keyboard.press('Delete');
  await waitFor(async () => (await tree()).slice(-2).join() === 'P- Cooking ideas,  E', 'videos removed');
  await expectStatus(/^Removed 3 videos\./);
  await statusButton('Undo').click();
  await expectTree(before);
  assert.equal(await button('Push to YouTube').locator('.pm-count').isVisible(), false, 'nothing from YouTube yet, so nothing to push');
});

step('exports one JSON file with the structure and full video data', async () => {
  await page.waitForTimeout(500); // let the debounced save finish
  const downloadPromise = page.waitForEvent('download');
  await button('Export').click();
  const download = await downloadPromise;
  assert.match(download.suggestedFilename(), /^youtube-playlist-manager-backup-\d{4}-\d{2}-\d{2}\.json$/);
  const backup = JSON.parse(fs.readFileSync(await download.path(), 'utf8'));
  assert.deepEqual(M.validate(backup), []);
  assert.equal(backup.version, 2);
  const stored = await storage();
  assert.deepEqual(backup.root, stored['pm.structure'].root);
  assert.deepEqual(backup.folders, stored['pm.structure'].folders);
  assert.equal(backup.videos.sampleVid01.statistics.viewCount, '1000');
  assert.equal(backup.videos.sampleGone1.unavailable, true);
  await expectStatus(/Exported 3 folders, 5 playlists and 12 videos/);
});

step('keeps everything after a page reload', async () => {
  const before = await tree();
  await page.reload();
  await page.locator(`${HOST} .pm-row`).first().waitFor();
  await expectTree(before);
});

step("follows YouTube's dark theme", async () => {
  const theme = () => page.evaluate(() => document.querySelector('#youtube-playlist-manager').shadowRoot.querySelector('.pm').dataset.theme);
  assert.equal(await theme(), 'light');
  await page.evaluate(() => document.documentElement.setAttribute('dark', ''));
  await waitFor(async () => (await theme()) === 'dark', 'dark theme');
  await shot('3-dark');
  await page.evaluate(() => document.documentElement.removeAttribute('dark'));
  await waitFor(async () => (await theme()) === 'light', 'light theme');
});

step('leaves with in-app navigation and comes back', async () => {
  await page.click('nav a[href="/"]');
  await waitFor(async () => (await page.locator(HOST).count()) === 0, 'dashboard removed');
  await page.click('nav a[href="/feed/playlists"]');
  await page.locator(`${HOST} .pm-row`).first().waitFor();
});

step('puts itself back if YouTube re-renders the page', async () => {
  await page.evaluate(() => document.querySelector('#youtube-playlist-manager').remove());
  await page.locator(HOST).waitFor({ timeout: 3000 });
  await page.locator(`${HOST} .pm-row`).first().waitFor();
});

step('collapses, and remembers that across reloads', async () => {
  await page.locator(`${HOST} .pm-collapse`).click();
  await waitFor(async () => (await storage())['pm.ui']?.collapsed === true, 'collapsed state saved');
  await page.reload();
  await page.locator(`${HOST} .pm-collapse[aria-expanded="false"]`).waitFor();
  assert.equal(await page.locator(`${HOST} .pm-tree`).isVisible(), false);
  await page.locator(`${HOST} .pm-collapse`).click();
  await page.locator(`${HOST} .pm-tree`).waitFor();
});

step('shows changes made in another tab', async () => {
  const other = await context.newPage();
  await other.goto('https://www.youtube.com/feed/playlists');
  await other.locator(`${HOST} .pm-row`).first().waitFor();
  await button('Folder').click();
  await page.keyboard.type('Shared');
  await page.keyboard.press('Enter');
  await waitFor(async () => (await tree(other))?.includes('F- Shared'), 'new folder in the other tab');
  await other.close();
});

step('rejects a damaged backup and says why', async () => {
  const before = await tree();
  const bad = path.join(tmp, 'bad.json');
  fs.writeFileSync(bad, JSON.stringify({ format: 'youtube-playlist-manager', version: 2, root: ['ghost'], folders: {}, playlists: {}, videos: {} }));
  await chooseFile(bad);
  await expectStatus(/Couldn't import “bad\.json”: The top level lists "ghost", which is not a folder or playlist/);
  assert.deepEqual(await tree(), before);
});

step('asks before replacing the library on import, and can be declined', async () => {
  const before = await tree();
  acceptDialogs = false;
  await chooseFile(SAMPLE);
  await page.waitForTimeout(300);
  acceptDialogs = true;
  assert.match(dialogs.at(-1), /^Replace your current library/);
  assert.deepEqual(await tree(), before);
});

step('explains how to set up syncing when no client ID is configured', async () => {
  await button('Pull from YouTube').click();
  await expectStatus(new RegExp(`isn't set up yet.*https://${EXTENSION_ID}\\.chromiumapp\\.org/`));
  assert.equal(await button('Pull from YouTube').isEnabled(), true);
});

// --- syncing with (a fake) YouTube ---------------------------------------------------

step('pulls from YouTube, asking before replacing a library from another channel', async () => {
  await worker.evaluate(FAKE_YOUTUBE);
  await worker.evaluate(() => {
    const titles = {
      run1: 'Run: warm-up', run2: 'Run: tempo', run3: 'Run: cool-down', new1: 'Run: hill sprints',
      focus1: 'Focus: lo-fi beats', focus2: 'Focus: brown noise', cook1: 'Cook: pasta', new2: 'Guitar: first chords',
      liked1: 'Liked: funny cats', liked2: 'Liked: travel vlog', liked3: 'Liked: space documentary',
    };
    self.fakeYouTube = createFakeYouTube({
      channel: { id: 'UCe2e', title: 'E2E Channel' },
      playlists: [
        { id: 'PLrun', title: 'Morning run', videos: ['run1', 'run2', 'run3'] },
        { id: 'PLfocus', title: 'Deep focus', videos: ['focus1', 'focus2'] },
        { id: 'PLcook', title: 'Cooking', videos: ['cook1'] },
      ],
      liked: ['run1', 'liked1', 'liked2'],
      videos: Object.fromEntries(Object.entries(titles).map(([id, title]) => [id, { title, channelTitle: 'Some Channel' }])),
    });
    self.fetch = (url, init) => self.fakeYouTube.fetch(url, init);
    self.PM_CONFIG.googleClientId = 'test-client.apps.googleusercontent.com';
    self.authUrls = [];
    chrome.identity.launchWebAuthFlow = async ({ url }) => {
      self.authUrls.push(url);
      const q = new URL(url).searchParams;
      const write = q.get('scope').split(' ').includes('https://www.googleapis.com/auth/youtube');
      return `${q.get('redirect_uri')}#access_token=${write ? 'write-token' : 'read-token'}&token_type=Bearer` +
        `&expires_in=3599&scope=${encodeURIComponent(q.get('scope'))}&state=${q.get('state')}`;
    };
  });

  await button('Pull from YouTube').click();
  await expectStatus(/^Your library's playlists come from “You”, but you signed in as “E2E Channel”\./);
  await statusButton('Replace library').click();
  await expectStatus(/^Pulled 3 playlists with 6 videos, plus 3 liked videos\./);
  await expectTree(['P+ Liked videos', 'P+ Morning run', 'P+ Deep focus', 'P+ Cooking']);
  const auth = new URL((await worker.evaluate(() => self.authUrls))[0]).searchParams;
  assert.equal(auth.get('scope'), 'https://www.googleapis.com/auth/youtube.readonly', 'pulling only asks to read');
  assert.equal(auth.get('redirect_uri'), `https://${EXTENSION_ID}.chromiumapp.org/`);
});

step('organizes playlists into folders and copies videos out of Liked videos', async () => {
  await button('Folder').click();
  await page.keyboard.type('Fitness');
  await page.keyboard.press('Enter');
  await playlistRow('PLrun').dragTo(row('Fitness'));
  for (const id of ['LL', 'PLfocus', 'PLcook']) await playlistRow(id).locator('.pm-name').click();
  await videoIn('LL', 'Liked: funny cats').dragTo(playlistRow('PLcook'));
  await videoIn('PLfocus', 'Focus: brown noise').dragTo(videoIn('PLcook', 'Cook: pasta'), { targetPosition: { x: 200, y: 4 } });
  await expectTree([
    'P- Liked videos',
    '  V Run: warm-up',
    '  V Liked: funny cats',
    '  V Liked: travel vlog',
    'P- Deep focus',
    '  V Focus: lo-fi beats',
    'P- Cooking',
    '  V Focus: brown noise',
    '  V Cook: pasta',
    '  V Liked: funny cats',
    'F- Fitness',
    '  P+ Morning run',
  ]);
  assert.equal(await button('Push to YouTube').locator('.pm-count').innerText(), '3');
  assert.equal(await playlistRow('PLcook').locator('.pm-badge--pending').innerText(), '2 to push');
  assert.equal(await playlistRow('PLfocus').locator('.pm-badge--pending').innerText(), '1 to push');
  await shot('4-to-push');
});

step('pushes changes to YouTube after showing what will change', async () => {
  const from = await requestCount();
  await button('Push to YouTube').click();
  await expectStatus(/^Push 3 changes to YouTube\? This uses about 150 of your 10,000 daily API units\.\n“Deep focus”: remove 1 video\n“Cooking”: add 2 videos/);
  assert.doesNotMatch(await page.locator(HOST).innerText(), /\bnull\b|undefined/);
  assert.deepEqual(await readsSince(from), ['PLfocus', 'PLcook', 'LL'], 'only the playlists being pushed are read (and Liked videos checked)');
  await shot('5-push-question');
  await statusButton('Push 3 changes').click();
  await expectStatus(/^Pushed 3 changes to YouTube\./);
  assert.deepEqual(await onYouTube('PLcook'), ['focus2', 'cook1', 'liked1']);
  assert.deepEqual(await onYouTube('PLfocus'), ['focus1']);
  assert.deepEqual(await onYouTube('LL'), ['run1', 'liked1', 'liked2'], 'Liked videos is never changed');
  await waitFor(async () => !(await button('Push to YouTube').locator('.pm-count').isVisible()), 'nothing left to push');
  const scopes = (await worker.evaluate(() => self.authUrls)).map((url) => new URL(url).searchParams.get('scope'));
  assert.deepEqual(scopes, ['https://www.googleapis.com/auth/youtube.readonly', 'https://www.googleapis.com/auth/youtube'],
    'pushing asked for permission to change playlists, once');
});

step('cancelling a push changes nothing on YouTube', async () => {
  await playlistRow('PLrun').locator('.pm-name').click();
  await videoIn('PLrun', 'Run: tempo').dragTo(videoIn('PLrun', 'Run: warm-up'), { targetPosition: { x: 200, y: 4 } });
  await waitFor(async () => (await button('Push to YouTube').locator('.pm-count').innerText()) === '1', 'one change to push');
  await button('Push to YouTube').click();
  await expectStatus(/^Push 1 change to YouTube\?.*\n“Morning run”: reorder \(1 move\)/);
  await statusButton('Cancel').click();
  await expectStatus(/^Push cancelled\. Nothing was changed on YouTube\./);
  assert.deepEqual(await onYouTube('PLrun'), ['run1', 'run2', 'run3']);
  assert.equal(await button('Push to YouTube').locator('.pm-count').innerText(), '1');
});

step('pulling again brings in YouTube changes without touching your folders, reading only what changed', async () => {
  await worker.evaluate(() => {
    self.fakeYouTube.addVideo('PLrun', 'new1');
    self.fakeYouTube.addPlaylist('PLguitar', 'Guitar', ['new2']);
    self.fakeYouTube.addVideo('LL', 'liked3', 0);
  });
  const from = await requestCount();
  await button('Pull from YouTube').click();
  await expectStatus(/^Pulled the latest from YouTube\. 1 change made here isn't on YouTube yet; Push to send it\.\nNew playlist “Guitar” \(1 video\), added at the top level\n“Morning run”: 1 new video on YouTube/);
  assert.deepEqual(await readsSince(from), ['PLrun', 'PLguitar', 'LL'], 'the pushed playlists are known to be unchanged');
  await expectTree([
    'P- Liked videos',
    '  V Liked: space documentary',
    '  V Run: warm-up',
    '  V Liked: funny cats',
    '  V Liked: travel vlog',
    'P- Deep focus',
    '  V Focus: lo-fi beats',
    'P- Cooking',
    '  V Focus: brown noise',
    '  V Cook: pasta',
    '  V Liked: funny cats',
    'F- Fitness',
    '  P- Morning run',
    '    V Run: tempo',
    '    V Run: warm-up',
    '    V Run: cool-down',
    '    V Run: hill sprints',
    'P+ Guitar',
  ]);
});

step('Liked videos stays read-only', async () => {
  const before = await tree();
  await videoIn('PLcook', 'Cook: pasta').dragTo(playlistRow('LL'));
  await page.waitForTimeout(300);
  assert.deepEqual(await tree(), before);
  await videoIn('LL', 'Liked: travel vlog').locator('.pm-index').click();
  assert.equal(await page.locator(`${HOST} .pm-selection .pm-btn--danger`).isDisabled(), true);
  await page.keyboard.press('Escape');
});

step('pushes the remaining reorder', async () => {
  await button('Push to YouTube').click();
  await statusButton('Push 1 change').click();
  await expectStatus(/^Pushed 1 change to YouTube\./);
  assert.deepEqual(await onYouTube('PLrun'), ['run2', 'run1', 'run3', 'new1']);
  await shot('6-synced');
});

step('a pull with nothing new reads no playlist; Shift-click reads everything again', async () => {
  let from = await requestCount();
  await button('Pull from YouTube').click();
  await expectStatus(/^Already up to date with YouTube\.$/);
  assert.deepEqual(await readsSince(from), ['LL']);

  // A video swapped for another on YouTube, keeping the size and first video: YouTube's version tag stays the same.
  await worker.evaluate(() => {
    self.fakeYouTube.removeVideo('PLrun', 'run3');
    self.fakeYouTube.addVideo('PLrun', 'focus1');
  });
  from = await requestCount();
  await button('Pull from YouTube').click({ modifiers: ['Shift'] });
  await expectStatus(/^Pulled the latest from YouTube\.\n“Morning run”: 1 new video, 1 removed on YouTube$/);
  assert.deepEqual(await readsSince(from), ['PLrun', 'PLfocus', 'PLcook', 'PLguitar', 'LL']);
  assert.ok(await videoIn('PLrun', 'Focus: lo-fi beats').isVisible());
  assert.equal(await videoIn('PLrun', 'Run: cool-down').count(), 0);
});

step('loads a library saved by older versions', async () => {
  await page.waitForTimeout(500); // let any debounced save finish
  const before = await tree();
  await worker.evaluate(async () => {
    const { 'pm.structure': structure } = await chrome.storage.local.get('pm.structure');
    await chrome.storage.local.set({
      'pm.structure': { ...structure, format: 'playlist-manager', version: 1 },
      'pm.meta': { rev: Date.now(), by: 'old-version' },
    });
  });
  await page.reload();
  await expectTree(before);
  assert.equal(await page.locator(`${HOST} .pm-status[data-kind="error"]`).count(), 0, 'no "damaged library" error');
  await playlistRow('PLguitar').locator('.pm-name').click();
  await waitFor(async () => {
    const { format, version } = (await storage())['pm.structure'];
    return format === 'youtube-playlist-manager' && version === 2;
  }, 'format name and version updated on the next save');
});

// --- runner -------------------------------------------------------------------------

async function main() {
  context = await chromium.launchPersistentContext(path.join(tmp, 'profile'), {
    channel: 'chromium',
    headless: true,
    acceptDownloads: true,
    viewport: { width: 1280, height: 900 },
    args: [`--disable-extensions-except=${EXTENSION}`, `--load-extension=${EXTENSION}`],
  });
  await context.route('https://www.youtube.com/**', (route) => route.fulfill({
    status: 200,
    contentType: 'text/html',
    headers: { 'content-security-policy': "require-trusted-types-for 'script'" },
    body: MOCK_PAGE,
  }));
  await context.route('https://i.ytimg.com/**', (route) => route.fulfill({ status: 200, contentType: 'image/png', body: PIXEL }));

  worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  page = await context.newPage();
  page.on('dialog', (dialog) => {
    dialogs.push(dialog.message());
    if (acceptDialogs) dialog.accept();
    else dialog.dismiss();
  });

  let failed = 0;
  for (const { name, fn } of steps) {
    try {
      await fn();
      console.log(`  ✓ ${name}`);
    } catch (err) {
      failed++;
      console.log(`  ✗ ${name}\n${String(err.stack || err).replace(/^/gm, '      ')}`);
      const file = path.join(tmp, 'failure.png');
      await page.screenshot({ path: file, fullPage: true }).catch(() => {});
      console.log(`      screenshot: ${file}`);
      break;
    }
  }
  await context.close();
  console.log(failed ? '\nE2E FAILED' : `\nAll ${steps.length} end-to-end steps passed.`);
  process.exitCode = failed ? 1 : 0;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
  context?.close();
});
