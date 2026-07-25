# virtual-keyboard-api-polyfill

A polyfill and ponyfill for the [VirtualKeyboard API](https://developer.mozilla.org/en-US/docs/Web/API/VirtualKeyboard_API) ([W3C spec](https://www.w3.org/TR/virtual-keyboard/)), built for Safari/iOS, Firefox, and WKWebView. It reports on-screen keyboard geometry through the standard API shape (`navigator.virtualKeyboard.boundingRect`, the `geometrychange` event, and `env(keyboard-inset-*)`), computed from `visualViewport`. Safari already leaves the layout viewport alone when the keyboard shows, so the job is to measure the visual-viewport shrink and expose it in the shape apps already target. This package does **not** polyfill viewport meta [`interactive-widget`](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/meta/name/viewport#interactive-widget) (e.g. `resizes-content`) — that is complementary Chromium UA policy.

Design contract: [`SPEC.md`](SPEC.md).

## Browser support reality

| Engine                              | Status                                                                                                                                                 |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Chromium (Chrome, Edge, and others) | Native since version 94. This polyfill defers to the native implementation and does nothing.                                                           |
| Safari / WebKit                     | Not implemented. Tracked in [WebKit/standards-positions#16](https://github.com/WebKit/standards-positions/issues/16). This polyfill fills the gap.     |
| Firefox                             | Not implemented. Tracked in [mozilla/standards-positions#531](https://github.com/mozilla/standards-positions/issues/531). This polyfill fills the gap. |

## Install

```sh
npm install virtual-keyboard-api-polyfill
```

Zero runtime dependencies.

## Quick start (auto entry)

```js
import "virtual-keyboard-api-polyfill/auto";

navigator.virtualKeyboard.addEventListener("geometrychange", () => {
  const { height } = navigator.virtualKeyboard.boundingRect;
  console.log("keyboard height:", height);
});
```

Import-safe in Node/SSR: outside a browser it does nothing.

## overlaysContent on Chromium

Chromium ships native VirtualKeyboard but does not enable overlay mode by default. Set `navigator.virtualKeyboard.overlaysContent = true` so native `env(keyboard-inset-*)` matches Safari’s overlay model (layout viewport stays fixed; keyboard draws over content). `/auto` does **not** set this flag — authors opt in explicitly. On Safari / Firefox / WKWebView the polyfill stores the flag; `true` is a no-op and `false` is unsupported.

## Ponyfill usage

```js
import { createVirtualKeyboard } from "virtual-keyboard-api-polyfill";

const virtualKeyboard = createVirtualKeyboard({
  cssProperties: true, // write --keyboard-inset-* on :root (default false for ponyfill)
});

virtualKeyboard.ongeometrychange = () => {
  const rect = virtualKeyboard.boundingRect;
  // All zeros when hidden. height is the load-bearing field.
};
```

Direct construct (tests / custom globals):

```js
import { VirtualKeyboardPolyfill } from "virtual-keyboard-api-polyfill";

const vk = new VirtualKeyboardPolyfill({
  window: myWindow,
  document: myDocument,
  cssProperties: true,
});

vk.isPolyfill; // true
vk.dispose();
```

### API surface

- `boundingRect: DOMRectReadOnly` — physical keyboard height while open; zeros when hidden. `x`/`y` are approximations.
- `overlaysContent: boolean` — stored flag; `false` is not emulated.
- `show()` / `hide()` — best-effort refocus / blur active editable.
- `geometrychange` — via `addEventListener` or `ongeometrychange`.
- `dispose()` / `isPolyfill` — polyfill only.

## CSS usage

`env()` cannot be defined from JS. The polyfill writes `--keyboard-inset-*` on `:root`. Wire both engines with:

```css
bottom: env(keyboard-inset-height, var(--keyboard-inset-height, 0px));
```

Native `env()` wins on Chromium; polyfilled browsers use the custom property; if JS never ran, the final fallback applies.

**Dual metrics:** W3C VirtualKeyboard defines `boundingRect` and insets relative to the document layout viewport. This polyfill’s CSS channel uses **remainder** — occlusion of the pre-keyboard **visible band** (Safari dual-metric baseline), not layout-viewport math. `boundingRect` reports **trueHeight** (physical OSK). CSS insets use **remainder** (lift still needed after Safari scroll compensation), so bottom-fixed UI is not double-lifted. On WKWebView the two usually coincide. **Remainder is internal** — not exposed on `navigator.virtualKeyboard`; read the CSS channel instead (below). Details in [SPEC](SPEC.md).

### Reading inset height from JS (transforms)

Use the same `--keyboard-inset-height` value CSS uses — do not derive lift from `boundingRect.height` on dual-metric engines:

```js
function getKeyboardInsetHeight() {
  const raw = getComputedStyle(document.documentElement)
    .getPropertyValue("--keyboard-inset-height")
    .trim();
  return raw ? parseFloat(raw) : 0;
}

// Re-read after geometrychange when driving transforms:
navigator.virtualKeyboard.addEventListener("geometrychange", () => {
  composer.style.transform = `translateY(-${getKeyboardInsetHeight()}px)`;
});
```

Requires `cssProperties: true` (or `/auto`). On Chromium with native insets, prefer `env(keyboard-inset-height)` in CSS; for JS-driven transforms, read computed `env()` indirectly via the same custom property if you mirror it, or measure layout (probe below).

## Safari chat UI (Recipe)

**Requires** an overflow-hidden shell with an inner scroller — **incompatible with document-scrolling / window-virtualized apps**. Fit and shell CSS: [`docs/ios-composer.md`](docs/ios-composer.md).

Fixed bottom composers need more than geometry: a layout shell, pre-lift on `mousedown`, and `focus({ preventScroll: true })`. That lives in a separate entry — not installed by `/auto`:

```js
import "virtual-keyboard-api-polyfill/auto";
import { attachIosComposer } from "virtual-keyboard-api-polyfill/ios-composer";
```

Docs: [`docs/ios-composer.md`](docs/ios-composer.md). Optional shell CSS: [`docs/ios-composer.shell.css`](docs/ios-composer.shell.css). Demo: `demo/index.html`.

**Recipe CSS assumption (chrome-visible Safari):** `bottom: env(keyboard-inset-height, var(--keyboard-inset-height))` assumes the overflow-hidden shell from the Recipe — fixed chrome’s containing block bottom aligns with the pre-keyboard visible band. In **document-scrolling** apps where browser chrome is visible and layout viewport bottom (`clientHeight`) ≠ visible band bottom, remainder can **over-lift** (e.g. ~92 px): remainder answers band occlusion while `position: fixed; bottom: 0` tracks the layout viewport. The correct lift there is `clientHeight - visualViewport.height - visualViewport.offsetTop`, not remainder alone.

**Measured fixed-probe escape hatch:** when you cannot adopt the Recipe shell, anchor lift to layout viewport bottom with a zero-size probe:

```html
<div id="vk-probe" aria-hidden="true" style="position:fixed;bottom:0;left:0;width:0;height:0;pointer-events:none"></div>
```

```js
function measuredLiftPx() {
  const probe = document.getElementById("vk-probe");
  const vv = window.visualViewport;
  if (!probe || !vv) return 0;
  return Math.max(0, probe.getBoundingClientRect().bottom - vv.height);
}
```

Use this for `transform` / `bottom` in document-scrolling layouts; keep remainder-driven CSS for Recipe shells.

## Limitations

- `overlaysContent = false` is not emulated
- Viewport meta `interactive-widget` (including `resizes-content`) is not polyfilled — set it on Chromium Android; on Safari use geometry + optional [`/ios-composer`](docs/ios-composer.md)
- `show()` is best-effort only (iOS user-gesture limits)
- Geometry commits after an 80 ms height-stability filter (plus animation), so updates lag Chrome-during-animation
- Top / already-visible inputs that do not shrink the visual viewport are undetectable → report zeros (hard limit)
- Floating / split / hardware keyboards report ~0 occlusion
- `virtualKeyboardPolicy` is out of v1
- Rotate while keyboard open may zero the rect until dismiss + reopen
- Non-touch devices always report zeros (by design)
- Recipe shell / pre-lift are opt-in via `/ios-composer`, not part of the polyfill core

## SSR and Node

Every entry is import-safe. `/auto` guards on `typeof window`. Constructing without a window attaches no listeners and does not throw.

## License

MIT (c) Cameron Pak
