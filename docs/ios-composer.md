# iOS composer Recipe

Safari chat-UI readiness: keep a fixed/sticky bottom composer above the keyboard without inventing a second geometry engine.

This is **not** the VirtualKeyboard polyfill. Height comes only from `navigator.virtualKeyboard` / this package’s ponyfill (`boundingRect`, `geometrychange`, `--keyboard-inset-*`). Layout shell, pre-lift, and focus timing are Recipe concerns.

Polyfill contract: [`SPEC.md`](../SPEC.md).

## Problem

On iOS Safari / WKWebView, focusing a bottom composer often:

1. Scrolls or jumps the page so the field clears the keyboard (visibility check before focus).
2. Rubber-bands fixed chrome when the document can still scroll.
3. Leaves the composer under the keyboard when VV shrinks but layout does not.

Insets alone (`bottom: env(keyboard-inset-height, …)`) are not enough. You need a **layout shell** plus **pre-lift on `mousedown`** (before focus) and `focus({ preventScroll: true })`.

## Prerequisites

1. Install the polyfill (or use native Chromium):

   ```js
   import "virtual-keyboard-api-polyfill/auto";
   // or createVirtualKeyboard({ cssProperties: true })
   ```

2. On Chromium, set `navigator.virtualKeyboard.overlaysContent = true` so native insets match the overlay model Safari already uses.

3. Apply the required CSS shell below (JS does not force `html`/`body` overflow).

4. Then wire `attachIosComposer` from `virtual-keyboard-api-polyfill/ios-composer`.

## Required CSS shell

Authors must apply this (or equivalent). Optional copy-paste: [`ios-composer.shell.css`](ios-composer.shell.css).

- `html, body, #root { height: 100%; overflow: hidden }`
- App column: `100dvh` flex; only the messages region scrolls
- Messages: `min-height: 0; overflow-y: auto; overscroll-behavior: contain`
- Composer pinned (`fixed` or `sticky`); offset via:

  ```css
  bottom: env(keyboard-inset-height, var(--keyboard-inset-height, 0px));
  ```

  and/or a transform driven by the same height cache used for pre-lift
- `touch-action: none` on non-scroll chrome (header, banners — not the message list)

## `attachIosComposer` API

```js
import { attachIosComposer } from "virtual-keyboard-api-polyfill/ios-composer";

const { dispose } = attachIosComposer({
  composer, // HTMLElement — fixed/sticky bar root
  // fields?: Iterable<HTMLElement> — default: texty controls inside composer
  // controls?: Iterable<HTMLElement> — send, attach, etc. (gated pre-lift)
  // virtualKeyboard?: { boundingRect, addEventListener, removeEventListener }
  // scrollTarget?: Window | Element — default window
  // getHeight?: () => number — test seam only; default boundingRect.height
});

// later
dispose();
```

### What it wires

| Behavior | Detail |
| --- | --- |
| Pre-lift | On field `mousedown`, apply last-known keyboard height to the composer **before** focus (defeats Safari’s pre-focus visibility scroll) |
| Focus | `focus({ preventScroll: true })` + `preventDefault` on field `mousedown` |
| Gated bar controls | On `controls`, pre-lift only when height &gt; 0 (no phantom lift when keyboard closed) |
| Height cache | `geometrychange` → cache height; **do not** re-measure `visualViewport` |
| Scroll safety net | While height &gt; 0, snap `scrollTarget` to top on scroll (globe key / mode switch has no DOM pre-lift) |

Side-effect-free import: does **not** install the polyfill. Zero framework deps.

### Not in v1

React hooks, parallel VV height APIs, device whitelists, CSS-in-JS, automatic mutation of `html`/`body` styles.

## Demo

`demo/index.html` — chat-style layout with a Fix ON/OFF toggle that wires / tears down `attachIosComposer`. Serve statically (e.g. `bunx serve`) and verify on a phone.

## Limitations (Recipe-only)

- Requires author CSS shell; hooks alone will not fix a scrollable document
- Not a VirtualKeyboard polyfill; without `/auto` or native VK + insets, height stays 0
- Does not reimplement settle / VV math — lag and hard limits match the polyfill ([SPEC](../SPEC.md))
- Pre-lift needs a prior non-zero height cache for first open after cold load (first focus may still jump once until `geometrychange` fills the cache)
- Does not silently set global `overflow: hidden`
