# Release preparation validation — October 25, 2026

Version: 0.1.3

- `npm run test:fast`: passed, zero failures.
- `npm run typecheck`: passed.
- `node tests/localization.test.cjs`: passed after branding changes.
- `npm run test:browser`: passed with normal Chrome process access; sandbox process access caused browser startup failures.
- `npm run store:assets`: passed; visually inspected both 1280×800 listing screenshots. They render real popup source with fixture responses. No live game credentials or data were used.
- `npm run store:package`: passed. Explicit runtime allowlist and manifest-reference checks verified the ZIP. Store copy and development files are excluded.
- `.gitignore` checks: local Codex config, dependencies, environment files, credentials, test outputs and release ZIP are excluded. Secret-pattern scan found no production-token patterns in eligible source.
- `npm run test:integration`: **not passed**. With normal process access it passed popup recovery, translation, storage authorization, position persistence, context/flag saves and read-only order helper, then timed out at the existing `window.warmSubscribed` wait (line 139 when run). This is the passive-cache subscription check. Do not claim complete integration validation.
- Live authenticated game acceptance: pending; existing contract-response capture limitations remain recorded in `Repo_Current_State.md`.

Package: `release/warera-tactical-0.1.3.zip`

SHA-256: `cc965c3132dcf779fe32c9115cc1aa5ea06385160f252bb1b0bed3147080bb25`

GitHub publication: succeeded after the publisher updated the connection. The `.gitignore` initialization commit is `86301a5b6a396ec0612f5867e10fcefe49fd9a13`. Source commit `fad578fd305cb4082898b7490320bd94f64cbc7a` published all 101 eligible project files to `main`, including 11 PNG assets. The manifest, public policy and ignore rules were read back through GitHub. No dependencies, local agent settings, secrets, release ZIPs or internal audit notes were uploaded.

Store submission: not performed. See `PUBLISHING.md` for publisher actions and Chrome acceptance steps.
