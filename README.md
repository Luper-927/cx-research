# CX

CX is a persistent, browser-based workspace that runs on your own device. This repository is its home: source, tests, and the deployment that publishes it.

**Status: Alpha 0.1.** It works and is tested, but it is a prototype, not a finished operating environment. See [Limitations](#limitations).

## What works today
Multiple workspaces. Files and folders (create, rename, edit, delete, search, upload text files). Snapshots with restore. A hash-linked journal with a verify button. Export and import of whole workspaces. A `cx.workspace/0.1` manifest validator. A terminal. Light and dark themes. Floating windows on desktop, full-screen apps on phones. Changes in one open tab appear in the others.

What is **not** implemented and not faked: remote computing, sync between devices, signed journal entries or keys, spending limits, AI agents.

## Use it
Open the published address (shown under **Settings > Environments > github-pages**, or in the latest successful run of the *Test, deploy and verify CX* workflow). Nothing to install.

The original CX Web v0.9 is preserved at `/legacy/cx-v0.9.html`.

## Where your data lives (read this)
Your workspaces are stored in your browser's IndexedDB, **separately for each web address**.

- The copy of CX that ran inside Claude had its own storage. **It does not carry over to GitHub Pages.** To move: in the old copy open *Workspaces*, choose *Export current*, then open the Pages copy, choose *Import*. Imports always create a new workspace and never overwrite anything.
- Data saved by v0.9 on this Pages address is still in the browser's `localStorage` under the key `cx`. CX Alpha offers to copy it into a new workspace. It never edits or deletes the original, so v0.9 keeps working.
- GitHub project pages share one address (`<user>.github.io`) with every other project under the same GitHub account. Other pages there could read this storage. Alpha stores no keys or secrets, but get your own domain before that changes.
- Clearing site data deletes workspaces. Export backups. The *Monitor* app can request persistent storage, which the browser may refuse.

**Recovery routes:** export files from the Workspaces app; automatic snapshots are taken before every restore, so a restore can be undone; the journal verifier reports damage; v0.9 data is never modified.

**No destructive migrations.** The database schema is version 1, unchanged from the validated build. A future schema change must keep old data readable and ship with a tested rollback before it is released.

## Deploy
The workflow `.github/workflows/pages.yml` does everything on every push to `main`:

1. **test**: checks every source file against `SOURCES.sha256` (this catches copy-and-paste mistakes and names the file), builds, and runs the end-to-end suite in Chromium against a server that mimics project-page hosting (`/cx-research/`).
2. **cross-browser**: runs the same suite in Firefox and WebKit. Report only; it does not block deployment.
3. **deploy**: publishes `_site/` (the app and `legacy/`) to GitHub Pages.
4. **verify**: waits until the live site serves this exact build, then runs the suite against the published URL, including real web fonts.

If **verify** is red, the deployed site is not trusted. A failed verify does not roll the site back automatically.

One-time setting: **Settings > Pages > Source: GitHub Actions** (the previous deployment already used it).

### Adopting this version from a phone, with no tools
1. In the repository on github.com open `index.html` (the old v0.9), tap the pencil, change the file name to `legacy/cx-v0.9.html`, and commit. This moves it unchanged.
2. Open `.github/workflows`, find the old deploy workflow (the one that uses `deploy-pages`) and delete it, or replace its contents with the new `pages.yml`. Two workflows publishing to Pages would conflict.
3. For every other file: Add file, Create new file, type the exact path, paste the exact contents, commit.
4. Watch **Test, deploy and verify CX** under Actions. If its first step names a file, that file was pasted with a mistake: re-paste it.
5. The built `index.html` is **not** committed. The workflow builds it from `src/`.

## Architecture
The published site is one self-contained `index.html`, built from `src/` by `node build.js` with no runtime dependencies. The workflow builds it; it is not committed.

| Module | Role |
|---|---|
| `00-util.js` | Hashing, canonical JSON, paths, DOM builder, file saving |
| `10-idb.js` | IndexedDB wrapper; the schema |
| `20-store.js` | Storage engine: workspaces, files, snapshots, journal, recovery, cross-tab sync |
| `40-manifest.js` | `cx.workspace/0.1` validator |
| `50-package.js` | `cx.package/0.1` export and import with full validation before any write |
| `60-legacy.js` | Reads v0.9 data without modifying it |
| `70-ui.js`, `71-shell.js` | Dialogs, toasts, window manager, command palette |
| `72` to `74-app-*.js` | The applications |

**Every change goes through one pipeline** (`commit()` in `20-store.js`): stage an intent record; build the change in memory; apply file entries, content, journal records and the workspace head in **one IndexedDB transaction**; read back and verify; then update the cache. A write interrupted at any point leaves either the whole change or none of it. Writes are serialised across tabs with Web Locks, with an in-tab fallback. Content is stored by SHA-256 hash and re-checked on every read.

**The journal** is a hash chain of records (`cx.log/0.1`) bound to a hash of the workspace contents. It is local and **unsigned**: it detects accidental damage and partial edits. It cannot detect someone who can rewrite the whole browser storage.

## Build and test
    node scripts/verify-sources.js   # every file matches SOURCES.sha256
    node build.js            # dist/index.html
    npm install              # Playwright (the only dev dependency)
    npx playwright install chromium
    node tests/run.js        # end-to-end suite
    CX_URL=https://<your published url>/ node tests/run.js   # against a live site
    PREFIX=/cx-research/ node tests/run.js                   # project-page hosting emulation
    BROWSER=firefox node tests/run.js                        # or webkit
    node tests/scale.js 2000 # scale measurement

`tests/fixtures/cx-v0.9.html` is a trimmed copy of v0.9 (its storage, journal, hashing and filesystem code verbatim, without the UI pages). Tests use the real `legacy/cx-v0.9.html` when it exists.

## Limitations
- Prototype. No security review. Do not store anything you cannot afford to lose, and do not treat the journal as proof against a determined attacker.
- Text files only, 5 MiB each. Search skips files over 1 MiB.
- Tested in Chromium, including phone emulation. Real Android use is verified only by the founder's manual test of an earlier build. Firefox and WebKit run in CI as report-only.
- The Pages address is shared with other projects under the same GitHub account (see above).
- Web fonts load from Google Fonts. Offline, system fonts are used.
- Screen readers have not been tested. Only accessible names, roles and focus handling are checked automatically.
- Tested to 2,000 files; behaviour beyond that is unknown.
