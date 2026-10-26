# Warera Tactical — Chrome Web Store submission

## Prepared deliverables

- Runtime: Manifest V3 extension, version 0.1.3, renamed in manifest, toolbar title, popup and Spanish title.
- Original compass logo: editable `assets/brand/mark.svg`; PNG icons at 16, 32, 48 and 128 px.
- Store graphics and actual settings screenshots: `store/assets/`, listed in `LISTING.md`.
- English listing: `LISTING.md`.
- Privacy policy: `PRIVACY.md`, with standalone `privacy.html` for HTTPS hosting.
- Permission and data declarations: `PRIVACY-DISCLOSURES.md`.
- Reviewer steps: `REVIEWER-INSTRUCTIONS.md`.
- Upload ZIP: run `npm run store:package`; output `release/warera-tactical-0.1.3.zip`, with manifest at the ZIP root.

## Build and inspect

1. Install pinned dev dependencies with `npm ci --ignore-scripts` if needed.
2. Run `npm run store:assets` with local Chrome installed. This uses a disposable test profile, actual popup source files, deterministic empty-profile fixture responses and blocked external network requests. It generates original vector-based artwork and PNG screenshots; it does not use live game data or AI-generated UI and does not validate service-worker integration. Run `node tools/privacy-html.cjs` after changing the Markdown privacy policy.
3. Run `npm test` and `npm run typecheck`.
4. Run `npm run store:package`. The explicit runtime allowlist excludes source audits, tests, dependencies, browser profiles, credentials, Git metadata and store documents. The script checks required manifest references in the archive and prints its SHA-256 checksum.
5. Extract ZIP to a fresh folder and load that extracted folder at `chrome://extensions` with Developer mode enabled. Check version, title and icon, then open Settings. Check English and Spanish titles and saved preferences after restart.

## Publisher actions still required

1. Public repository: https://github.com/eralexx/Warera-Tactical. GitHub write access is restored and the initial `.gitignore` commit succeeded. After the source commit, use this repository's Issues page for support and the `store/PRIVACY.md` URL in `LISTING.md` for privacy. Verify those links while signed out before submitting.
2. Publish the supplied policy as a publicly readable repository document or HTTPS page. Enter its verified public URL and the support URL in the store dashboard. A repository-hosted Markdown policy can be linked without enabling GitHub Pages; HTML hosting is optional.
3. Register or use your Chrome Web Store developer account, complete the dashboard's current contact/account verification and any applicable registration fee. Choose distribution regions, visibility and any publisher/trader disclosures requested by the dashboard.
4. Upload the ZIP, paste `LISTING.md` copy, and upload the store icon, two listing screenshots and small promo tile. The marquee is optional. Raw popup captures and SVG sources are not store uploads.
5. Complete Privacy practices using `PRIVACY-DISCLOSURES.md`, and Test instructions using `REVIEWER-INSTRUCTIONS.md`. Supply a dedicated test account/token privately if necessary; never use the user's current token or put it in GitHub.
6. Perform live acceptance checks for the features you advertise. Existing contract-response capture has pending authenticated live validation recorded in `Repo_Current_State.md`. Do not interpret successful local fixtures as proof that every game endpoint currently works.
7. Review the complete listing, declarations and distribution settings, then submit for review in the dashboard. These files do not constitute submission or guarantee approval.

## Chrome acceptance checklist

- Load the extracted ZIP without manifest/worker errors; confirm **Warera Tactical**, version 0.1.3 and compass icon.
- Open Settings in English and Spanish; confirm branding and connection disclosure. Save an ordinary preference, close/reopen the popup and confirm persistence.
- In a manually opened game tab, independently disable/re-enable market, battle, economy and radar features. Confirm owned UI is removed/recreated and pending responses do not restore disabled UI.
- Manually verify representative estimates against current game data. Check missing-data errors, contract availability and narrow screen layout.
- Confirm price helper only copies; no native game action is triggered. Check that disabled radars stop their feature-specific work and enabled notifications respect settings.
- Inspect worker requests: GET only, approved HTTPS API origins, no token in URLs or page DOM. Do not attach logs containing Authorization headers to public issues.

## Official guidance checked October 25, 2026

- [Listing fields and graphics](https://developer.chrome.com/docs/webstore/cws-dashboard-listing)
- [Image specifications](https://developer.chrome.com/docs/webstore/images)
- [Privacy fields](https://developer.chrome.com/docs/webstore/cws-dashboard-privacy)
- [Data handling FAQ](https://developer.chrome.com/docs/webstore/program-policies/user-data-faq)
- [Upload and submit](https://developer.chrome.com/docs/webstore/publish)

Prepared graphics cover 128 × 128 icon, 1280 × 800 screenshots, 440 × 280 small tile and optional 1400 × 560 marquee. Confirm the dashboard's current requirements when uploading.
