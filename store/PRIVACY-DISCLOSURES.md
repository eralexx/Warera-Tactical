# Chrome Web Store privacy and permissions fields

Use alongside `PRIVACY.md`; confirm the final dashboard choices accurately describe the submitted version.

## Single purpose

Provide read-only tactical insights for WarEra through contextual game overlays, calculations and configurable opportunity radars.

## Permission justifications

| Permission | Justification |
| --- | --- |
| storage | Persist the user's API connection, player ID, language, independent feature choices, display settings, cached game responses and radar state in this Chrome profile. |
| alarms | Schedule background refreshes for enabled opportunity radars and cache maintenance. |
| notifications | Display enabled bounty-opportunity alerts according to the user's configured thresholds and deduplication state. |
| https://*.warera.io/* | Run read-only overlays on app.warera.io and warera.io, and read approved official game API services. The worker restricts outbound routing to api2/api5; passive observers consume selected responses already made by the game. |
| https://gateway.warerastats.io/* | Read game data through Community Gateway when selected, and for bounded compatibility retries of supported rate-limited official requests. Gateway receives the configured API token and query; this is disclosed in the connection settings. |

## Remote code

Select **No, I am not using remote code**. Executable JavaScript, styles and translations ship in the ZIP. Remote responses are game data. MAIN-world observers are packaged local scripts.

## Data categories

Disclose data handling even when data stays local. Do not claim “no user data” simply because there is no analytics server.

- **Personally identifiable information:** configured player ID, in-game account identifiers and usernames from relevant game responses.
- **Authentication information:** user-entered API token, stored locally and transmitted to official APIs or Community Gateway.
- **Web history:** relevant WarEra page URLs/routes used to select contextual features; unrelated browsing is not collected.
- **Website content:** displayed WarEra information and selected native API response data used by enabled features.

No real-world financial/payment data, health data, location tracking or personal communications are requested. In-game gold, HP and battle positions are game metrics. No keystroke analytics or general mouse tracking is implemented; ordinary configuration inputs and panel dragging support the UI.

Certify the dashboard's limited-use statements only after reviewing them: no sale of user data, no unrelated uses/transfers, and no use for creditworthiness/lending. The supplied implementation and policy describe these practices.

## Before submission

Provide the public privacy-policy URL and support URL. Confirm that Community Gateway credential sharing (including Official-mode rate-limit recovery) remains disclosed in the UI, listing and policy. Never supply a real production API token in a public repository or listing. Any private review credential must be a dedicated test credential supplied directly through the dashboard.
