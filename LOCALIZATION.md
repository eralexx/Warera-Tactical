# Localization

The extension supports English (`en`, the default) and Spanish (`es`). The popup's
Language selector saves immediately and applies to open WarEra tabs. Language is
an independent presentation preference, not an enable/disable feature: selecting
it never changes feature flags, credentials, cache settings or radar thresholds.

## Messages

`i18n.js` exposes `globalThis.__weAgoI18n`. English source messages are catalog keys;
`locales/es.js` contains their Spanish translations. Missing keys and unsupported
saved language values fall back to English. Unknown server diagnostics retain
their original text instead of being guessed or hidden.

Use explicit calls for extension-authored text:

```js
t("Loading…")
t`No API price benchmark for ${itemCode}.`
```

Tagged templates become keys such as `No API price benchmark for {0}.` in the
catalog. Preserve every numbered placeholder in translations; placeholders may
be reordered. Interpolation runs once and never translates or evaluates the
inserted values. Render messages using `textContent` or text attributes, never
`innerHTML`. Pass player/company/region names and API item codes as values, not as
translation keys. Protocol fields, selectors, routes, enum comparisons and native
DOM recognition must remain independent of the selected extension language.

Popup static text uses `data-i18n` on text-only leaves. Translatable attributes use
`data-i18n-placeholder`, `data-i18n-title` or `data-i18n-aria-label`. Do not mark
containers that also contain controls, counts or icons: localization sets the
marked leaf's `textContent`. The popup's root `lang` follows the selected language.
Number/date formatting uses the selected locale; native input parsing and numeric
API parameters remain unchanged.

## Persistence and lifecycle

The worker validates and stores `we-ago:language` separately from existing
preferences. `WE_AGO_LANGUAGE_GET` is available to the popup and supported WarEra
pages. `WE_AGO_LANGUAGE_SAVE` is popup-only and accepts exactly `en` or `es`.
The worker broadcasts `WE_AGO_LANGUAGE_CHANGED` to supported tabs. Content scripts
never read the restricted credential store directly. Startup reads cannot overwrite
a more recent language change.

`content/main.js` subscribes to language changes and destroys/recreates only
enabled modules through their existing lifecycle methods. This updates static
labels, tooltips and accessibility text, stops old listeners/timers and rejects
late responses. Worker response caches remain available. Disabled features remain
disabled. Native game nodes are never localized. Notifications use the saved
language when generated. Unknown cached diagnostics may remain in their source
language. Owned inputs, disclosure state, focus/selection and scroll are restored during language rebuilds; census filter/sort state is restored through module lifecycle state. Unsaved Radar fields remain drafts until saved. Native controls remain untouched.

## Adding a language or message

1. Add the translation catalog and load it before `i18n.js` in the popup and
   isolated content script list; load it in the worker for notifications.
2. Add the language code to the validated lists in `i18n.js` and `background.js`,
   add its autonym to the popup selector and provide its formatting locale.
3. Keep every new extension label, tooltip and accessible description in the
   catalog workflow. Keep native-game recognition separate.
4. Run `node tests/localization.test.cjs` and
   `node tests/localization_browser.test.cjs`. The former checks placeholder
   parity, fallback, safe interpolation, preference authorization and notifications;
   the latter checks actual popup/content DOM, switching, saved flags, unsaved
   edits, native preservation and feature teardown in local headless Chrome.
