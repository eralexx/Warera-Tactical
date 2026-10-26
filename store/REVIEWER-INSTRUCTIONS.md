# Private reviewer instructions

Warera Tactical is an independent, read-only WarEra companion. It does not automate game actions or submit game mutations.

1. Install the submitted extension. Open its toolbar popup. Confirm **Warera Tactical** and **Settings**; switch between English and Español. Configuration UI is accessible without a game account.
2. For game overlays, sign into a dedicated WarEra test account at `https://app.warera.io/`. The publisher must supply any necessary account access in the private dashboard review fields before submission. No credential is included in the extension or repository.
3. In **API connection**, enter the dedicated WarEra API token. For personal calculations, enter the 24-character player ID from that account's `/user/` URL. Select Official and save. Gateway and bounded official rate-limit recovery can send the token to `gateway.warerastats.io`, as disclosed beside the provider controls.
4. Manually open market, battle and company views. The extension appends its own badges/calculations. Values depend on available game data and configured features. Missing API data produces contextual unavailable/error states.
5. Disable/re-enable each relevant feature in the popup. Owned UI should disappear/reappear in open game tabs. Feature choices, language and connection persist when reopening Chrome.
6. The order helper copies a suggested price; it does not place or change orders. Opportunity radars read data; enabling bounty notifications may show system notifications when a configured opportunity is found.
7. Remove the test token with **Remove token**, and clear responses using **Cache options → Clear** when finished.

Publisher preflight: privately verify the dedicated account and token work before supplying them. Do not submit this document as proof that credentials have already been provided. See repository state for the pending live contract-capture validation.
