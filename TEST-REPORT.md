# CX Alpha 0.1 test report (deployment milestone)

## What was actually run
`node tests/run.js` with `PREFIX=/cx-research/`: the built `index.html` served by a local server that imitates GitHub project-page hosting (sub-path, redirect from the address without a trailing slash, 404 elsewhere), driven by headless Chromium 153 through Playwright. **30/30 passed.**
Before that, the previous suite passed 25/25 on a plain local server, and each new test was run on its own first.

| Test | Result |
|---|---|
| 1. Loads without a blank screen or console errors | PASS |
| 2. Workspaces: create, switch, rename, independent data, delete with confirmation | PASS |
| 3 + 4. Create and edit a file; contents survive reload | PASS |
| 5. Folder holds multiple files; rename and recursive delete; search | PASS |
| 6 + 7. Snapshot create/restore; journal persists, verifies and records events | PASS |
| 7b. Journal detects tampering (edit, delete, reorder, outside change) | PASS |
| 8. Export and re-import a workspace (round trip) | PASS |
| 9. Invalid imports are rejected and change nothing | PASS |
| 10. Mobile layout is usable | PASS |
| 11. Manifest: validate, unsupported features, unknown fields, rejection of bad imports | PASS |
| 12. v0.9 data is found, verified and imported without touching the original | PASS |
| 13. Interrupted write is recovered; nothing half-applied | PASS |
| 14. Two tabs writing at once keep one valid, gap-free journal | PASS |
| 14b. A tab saving its layout while another tab writes cannot corrupt the journal | PASS |
| 14c. A second open tab shows changes live; unsaved text is protected; a workspace deleted in one tab moves the other tab to a valid one | PASS |
| 15. Keyboard: palette, file list keys, dialogs close with Escape | PASS |
| 16. Window management and layout persistence; theme persistence | PASS |
| 17. Upload: text accepted, binary and oversize rejected, nothing overwritten | PASS |
| 18. Editor never silently loses text (conflict, delete, discard) | PASS |
| 19. Accessibility basics: names, roles, contrast, reduced motion | PASS |
| 20. Terminal and Monitor operate on real data | PASS |
| 21. Dark theme renders (screenshot) and no console errors across all apps | PASS |
| 22. Writes still work when Web Locks are refused (sandboxed frames) and messages use curly quotes | PASS |
| 23. First run with v0.9 data tells the user, and changes nothing | PASS |
| 24. Performance measurements (reported, not tuned) | PASS |
| 25. Deployment: build id, secure context, routes, fonts | PASS |
| 26. Real v0.9 app data round trip: v0.9 writes, Alpha imports, v0.9 still works | PASS |
| 27. Data survives a full browser restart (new browser process, same profile) | PASS |
| 28. Killing the browser mid-write never leaves a broken workspace (3 kill points) | PASS |
| 29. Android phone profile (Pixel 7 emulation): full flow and persistence | PASS |

## Verified by running it
- All functionality of the validated baseline, unchanged (tests 1 to 24, 14b and 14c included).
- Files, settings, snapshots, journal head and open editor tabs survive a full browser restart: a new browser process on the same profile (test 27).
- Killing the browser while 40 writes are in flight, at three different moments, never produced a broken workspace: journal valid, every file readable, no leftover intents. Writes that had committed were kept: 8ms: 1/40 committed, recovered 0 / 30ms: 6/40 committed, recovered 0 / 90ms: 19/40 committed, recovered 1. In one run an interrupted write was found at startup, discarded and recorded in the journal (test 28).
- The app opens, reloads and restores its desktop at a sub-path address, and `legacy/cx-v0.9.html` is served next to it (test 25).
- **Real v0.9 round trip (test 26):** the v0.9 data-layer code wrote files, a note and edits; v0.9's own verifier accepted its chain; CX Alpha imported it and its port of the verifier accepted the same chain; the full old chain is kept; the original storage is byte-for-byte unchanged; v0.9 still opens and verifies afterwards.
- Export and import (file round trip, snapshots included), invalid imports rejected without changes, journal tamper detection, two tabs, keyboard, contrast (all 26 checks), 2,000-file scale: see the earlier results below.
- Android-phone profile in emulation (Pixel 7: 412 px wide, touch): create, edit, save, snapshot, export, import, reload (test 29).
- The CI workflow file parses and has the intended job dependencies. It has **not** been executed.
- The source-integrity check (`scripts/verify-sources.js`) was run against the files exactly as delivered and passes.

## Not verified. These are assumptions until the first run of the workflow
- **The published site.** This sandbox has no network access and GitHub blocks automated page reads, so I could not open the live address or push to the repository. Nothing was committed by me. The workflow's *verify* job runs the whole suite against your real published URL and fails if the live site is not serving the new build.
- The workflow itself on GitHub's runners (install steps, Playwright download, Pages permissions).
- Firefox and WebKit (report-only in CI, never run by me).
- Real Android hardware on the published site. You tested an earlier build on your phone; this build changed (build id in Settings > About).
- Real web fonts (CI loads them in the verify job; I always blocked them).
- Screen readers.
- `tests/fixtures/cx-v0.9.html` is a **trimmed** copy of v0.9 (original data-layer code verbatim, no UI pages). CI uses your real file from `legacy/`.

## Earlier results that still apply
Defects found and fixed in earlier rounds: stale-cache journal check; cross-tab layout race (reproduced, fixed); mobile header overflow; editor tabs not persisted; small touch targets; tabs not live-updating; Web Locks refused in sandboxed frames.

Measured performance (sandbox machine, Chromium; a phone will be slower). 300 files: {"files": 300, "createMsMedian": 2, "createMsP95": 35, "createMsMax": 69.5, "totalSec": 2.75, "verifyMs": 77, "verifyRecords": 302, "searchMs": 31, "searchHits": 200, "listMs": 3, "packageBuildMs": 17, "write1MiBMs": 22}
2,000 files: {"files": 2000, "createMsMedian": 3, "createMsP95": 9.9, "createMsMax": 75.4, "verifyMs": 212, "verifyValid": true, "journalRecords": 2003, "searchMs": 134, "searchHits": 40, "snapshotCreateMs": 19, "restoreMs": 771, "restoredFiles": 2001, "exportBuildMs": 205, "exportMiB": 3.44, "importValidateMs": 172, "importValid": true, "importWriteMs": 1115, "importedVerify": true, "renderRowsMs": 90, "rowsRendered": 2000, "storage": {"blobs": 2201, "blobMiB": 0.96}}

Contrast: all 26 checks pass (text 4.5, focus and borders 3). Lowest text ratio 4.81.
