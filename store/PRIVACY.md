# Warera Tactical privacy policy

Effective date: October 25, 2026

Warera Tactical is an independent Chrome extension that adds read-only tactical information to WarEra. This policy describes the extension's data handling.

## Data used

- **Authentication information:** the WarEra API token you enter in Settings.
- **Account identifiers:** your configured player ID and player, country, military-unit, company and battle identifiers needed for enabled features. Game responses can contain in-game usernames and profile information.
- **WarEra website content and activity:** relevant page addresses, displayed game information and selected native game API responses used to identify the current view and calculate or display enabled features. The extension does not inspect browsing on unrelated sites.
- **Local preferences and game data:** language, feature flags, display options, radar thresholds, panel position, cached API results, scan state and notification deduplication records.

## Use and storage

The extension uses this information to authenticate read-only game queries, calculate estimates, display information, cache results and provide enabled opportunity notifications. The API token and preferences are stored in Chrome extension local storage in your browser profile. Content scripts cannot directly read the token from trusted extension storage. This storage is not represented as a separate encrypted credential vault.

Cached responses have endpoint-specific expiry times. Expired records can remain stored until cache cleanup, eviction or manual clearing; expiry is not a promise of immediate physical deletion. Preferences and scan records can persist until changed, cleared or the extension is removed.

## External services and sharing

Authenticated queries are sent over HTTPS to approved official WarEra API services (`api2.warera.io`, and `api5.warera.io` for supported contract reads) and, when used, the Community Gateway at `gateway.warerastats.io`. Each authenticated request sends the API token in an Authorization header and the query parameters needed by the feature. The extension issues GET requests and does not submit game mutations.

Selecting Community Gateway sends your API token and query to that independent service, with bounded official fallback. Even with Official selected, certain rate-limited official queries may be retried through Community Gateway. The popup discloses this routing. These service operators may receive ordinary connection information, such as your IP address, and their own policies govern server-side processing and retention. This extension does not control or guarantee their deletion practices.

The extension contains no advertising, analytics or developer-operated telemetry endpoint. It does not sell data or use it for advertising, creditworthiness or lending decisions. It uses and transfers data only to provide the described user-facing features. It does not download or execute remote program code.

## Your controls

Use Settings to disable individual features, change your connection or player ID, remove the saved API token, and clear cached responses. Removing the token prevents future authenticated extension queries; it does not revoke the credential at the game provider. Revoke or replace it with WarEra if needed. Disabling a feature removes its UI and stops its future feature-specific work; shared data used by other enabled features may remain.

Uninstalling removes the extension's local storage. Deleting local records does not delete records independently retained by external API services.

## Support and updates

Support and privacy questions: [Warera Tactical GitHub Issues](https://github.com/eralexx/Warera-Tactical/issues), maintained by [eralexx](https://github.com/eralexx). Do not include API tokens in public support issues. If you send support information, GitHub handles that submission under its own privacy policy. Material changes to this policy will be reflected in a revised effective date.
