# Warera Tactical

Read-only Chrome extension for WarEra. Load this folder as an unpacked extension at `chrome://extensions`, reload game tabs, and configure the API connection and independent features in the popup. The order helper copies suggested prices; paste them into the game yourself.

Credentials remain in trusted extension storage. Official, Community Gateway and api5 routing follow `agents.md`; the popup discloses Gateway credential sharing. All extension API requests are authenticated GETs through the worker. Live/static cache lifetimes are capped at 60/300 seconds. Saved fallback lifetimes apply where no endpoint-specific policy exists.

## Chrome Web Store release

See `store/PUBLISHING.md` for the upload checklist, listing copy, privacy disclosures and reviewer instructions. Run `npm run store:assets` to regenerate icons, promotional artwork and screenshots in a disposable Chrome profile, then `npm run store:package` to build the runtime-only ZIP in `release/`. No saved browser settings or credentials are included. Public privacy-policy hosting and publisher contact details must be supplied before submission.

## Development checks

Use Node.js 22 or later and a local Chrome installation. Install the exact development dependencies with `npm ci --ignore-scripts`. Browser downloads and package lifecycle scripts are unnecessary; the integration lane uses the configured installed Chrome.

```text
npm test                  # syntax/manifest checks and every suite
npm run test:fast         # deterministic worker/VM/domain/scale checks
npm run test:browser      # local mocked DOM/layout fixtures
npm run test:integration  # actual unpacked extension in a disposable profile
npm run typecheck         # incremental shared-domain/API contract checking
```

Set `CHROME_PATH` for a nonstandard Chrome installation. The real-extension lane requires Chrome's `Extensions.loadUnpacked` debugging API and enables it only in its disposable test profile. All game pages and API responses in that lane are intercepted or mocked; dummy credentials never reach a live API. It tests actual Chrome storage permissions, popup/content sender boundaries, MAIN/isolated worlds, trusted Copy activation with a fake clipboard, partial popup startup/retry, preference propagation, cleanup and worker/browser restart. Browser startup failures are reported separately from fixture assertion failures. If a managed sandbox prevents Chrome startup, run the same local checks with authorized process access.

Optionally set `UX_SCREENSHOT_DIR` to save popup and narrow Radar screenshots from the integration test. No test uses the user's normal Chrome profile or real credentials. Test profiles are closed and removed only after checking their resolved path is the generated temporary directory.

## Architecture

- `background.js`: validated message boundary, preferences, context revisions, write barriers and authenticated transport/batching.
- `worker/radar.js`, `worker/census.js`: scan services, scoped cancellation, progress and notifications.
- `shared/`: feature registry, pure skill/build rules, bounded response cache, bounded scan concurrency and checked contracts.
- `content/api.js`: nonsecret context handshake and obsolete-response rejection.
- `content/main.js`, `content/observer.js`: isolated feature lifecycle, bounded error reporting, visibility/route discovery and clocks.
- `content/modules/`: independently enabled owned UI. `content/ui.js` reconciles keyed rows without replacing focused controls.

Preserve native game nodes/events, independent saved feature flags, token/provider cache isolation, partial-data semantics and cancellation guards. Extend shared normalized rules rather than duplicating domain calculations. Shared preloads in fixtures mirror manifest/worker imports; integration tests verify the actual packaging.

Implementation status is in `Repo_Current_State.md`. Synthetic scale checks establish bounded work; authenticated live-game CPU/memory profiling and native-theme checks remain manual acceptance work.
