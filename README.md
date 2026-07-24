# virtual-keyboard-api-polyfill

A polyfill and ponyfill for the [VirtualKeyboard API](https://developer.mozilla.org/en-US/docs/Web/API/VirtualKeyboard_API) ([W3C spec](https://www.w3.org/TR/virtual-keyboard/)), built for Safari/iOS, Firefox, and WKWebView. It reports on-screen keyboard geometry through the standard API shape (`navigator.virtualKeyboard.boundingRect`, the `geometrychange` event, and `env(keyboard-inset-*)`), computed from `visualViewport`. The core insight: Safari already behaves like `overlaysContent = true`, where the keyboard overlays the page and only the visual viewport shrinks, so the job is to measure that shrink and expose it in the shape apps already target.

## Browser support reality

| Engine | Status |
| --- | --- |
| Chromium (Chrome, Edge, and others) | Native since version 94. This polyfill defers to the native implementation and does nothing. |
| Safari / WebKit | Not implemented. Tracked in [WebKit/standards-positions#16](https://github.com/WebKit/standards-positions/issues/16) (position: "Needs position"). This polyfill fills the gap. |
| Firefox | Not implemented. Tracked in [mozilla/standards-positions#531](https://github.com/mozilla/standards-positions/issues/531). This polyfill fills the gap. |

On a Chromium browser the polyfill detects the native `navigator.virtualKeyboard` and steps aside. Everywhere else it derives the geometry itself.

## Install

```sh
npm install virtual-keyboard-api-polyfill
```

Zero runtime dependencies.

## Quick start (auto entry)

Import the side-effect entry once, near your app's entry point. It installs `navigator.virtualKeyboard` when the browser lacks it and starts keeping the `--keyboard-inset-*` CSS custom properties updated.

```js
import "virtual-keyboard-api-polyfill/auto";

// Now works in Safari/iOS/Firefox as it does natively in Chromium:
navigator.virtualKeyboard.addEventListener("geometrychange", () => {
  const { height } = navigator.virtualKeyboard.boundingRect;
  console.log("keyboard height:", height);
});
```

The auto entry is import-safe in Node and SSR: outside a browser it does nothing.

## Ponyfill usage

If you would rather not touch globals, use the ponyfill. `createVirtualKeyboard()` returns the native `navigator.virtualKeyboard` when it exists, and a `VirtualKeyboardPolyfill` instance otherwise. Either way you get the same surface.

```js
import { createVirtualKeyboard } from "virtual-keyboard-api-polyfill";

const virtualKeyboard = createVirtualKeyboard({
  // Write --keyboard-inset-* custom properties on every change.
  // Defaults to false for the bare ponyfill; opt in if you want the CSS vars.
  cssProperties: true,
});

virtualKeyboard.ongeometrychange = () => {
  const rect = virtualKeyboard.boundingRect;
  // rect: { x, y, width, height } (a DOMRectReadOnly). All zeros when hidden.
};
```

When you construct the polyfill directly you can inject the window and document (handy for tests or non-default globals):

```js
import { VirtualKeyboardPolyfill } from "virtual-keyboard-api-polyfill";

const vk = new VirtualKeyboardPolyfill({
  window: myWindow,     // defaults to globalThis.window
  document: myDocument, // defaults to globalThis.document
  cssProperties: true,  // defaults to false
});

// Polyfill-only extras:
vk.isPolyfill; // true
vk.dispose();  // remove all listeners when you are done
```

### API surface

The polyfill mirrors the standard `VirtualKeyboard` interface:

- `boundingRect: DOMRectReadOnly` - `{ x: 0, y: innerHeight - height, width: innerWidth, height }` while the keyboard is up, all zeros when hidden. `x` and `y` are approximations; `height` is the load-bearing value.
- `overlaysContent: boolean` - stored flag. `true` is the effective behavior on Safari already; `false` is not emulated (see limitations).
- `show()` - best-effort refocus of the active editable element.
- `hide()` - blurs the active editable element.
- `geometrychange` event - fired whenever the rect changes, including the transition back to zeros on hide. Listen via `addEventListener` or the `ongeometrychange` property.
- `dispose()` (polyfill only) - tears down every listener.
- `isPolyfill: true` (polyfill only) - lets you tell the polyfill from the native object.

## CSS usage

CSS `env()` variables cannot be defined from JavaScript, so the polyfill writes matching `--keyboard-inset-*` custom properties on `:root` instead. You wire native and polyfilled browsers together with one hand-written fallback chain, for any inset `X` in `{top, right, bottom, left, width, height}`:

```css
bottom: env(keyboard-inset-height, var(--keyboard-inset-height, 0px));
```

Why this chain is safe:

- Browsers with native VirtualKeyboard support resolve `env(keyboard-inset-height)` directly. The custom property is ignored, so there is no double compensation.
- Browsers without native support fall back to `var(--keyboard-inset-height, 0px)`, which resolves to the value the polyfill keeps updated.
- If JavaScript never runs (the custom property was never set), the final `0px` applies and layout stays sane.

### Worked example: a composer pinned above the keyboard

```css
.composer {
  position: fixed;
  left: 0;
  right: 0;
  bottom: env(keyboard-inset-height, var(--keyboard-inset-height, 0px));
}
```

When the keyboard opens, the composer lifts by exactly the keyboard height on every engine: native browsers via `env()`, polyfilled browsers via the custom property. When it closes, both resolve to `0px` and the composer returns to the bottom edge.

### CSS custom properties reference

All values are px strings on `document.documentElement`, written on every geometry change. They mirror the native `env(keyboard-inset-*)` variables for a docked keyboard with `overlaysContent = true`. All are `0px` while the keyboard is hidden.

| Custom property | `env()` equivalent | Docked value | Meaning |
| --- | --- | --- | --- |
| `--keyboard-inset-top` | `keyboard-inset-top` | `innerHeight - height` | Distance from the top edge to the top of the keyboard box. |
| `--keyboard-inset-right` | `keyboard-inset-right` | `0px` | Distance from the right edge to the keyboard box. |
| `--keyboard-inset-bottom` | `keyboard-inset-bottom` | `0px` | Distance from the bottom edge to the keyboard box. |
| `--keyboard-inset-left` | `keyboard-inset-left` | `0px` | Distance from the left edge to the keyboard box. |
| `--keyboard-inset-width` | `keyboard-inset-width` | `innerWidth` | Width of the keyboard box. |
| `--keyboard-inset-height` | `keyboard-inset-height` | keyboard height | Height of the keyboard box. This is the value most layouts want. |

The insets satisfy `top + height + bottom === innerHeight` for a docked keyboard.

## How it works

The engine listens to `visualViewport` `resize` and `scroll`, document `focusin` and `focusout`, and window `resize` and `orientationchange`, coalescing everything through `requestAnimationFrame`. Occlusion is only reported while a text-editable element is focused. At each `focusin` it captures a per-focus baseline (`visualViewport.height + visualViewport.offsetTop`) before the keyboard animates in, then reports `baseline - current viewport bottom` as the keyboard height. Capturing the baseline per focus rather than from `window.innerHeight` is what makes it correct in both classic iOS Safari (where `innerHeight` stays constant) and WKWebView/Capacitor (where `innerHeight` and the viewport shrink together).

## Limitations

This is a best-effort measurement layer, not the real thing. Known gaps:

- `overlaysContent = false` is not emulated. The value is stored but changing it does not resize the layout viewport.
- `show()` is best-effort only. iOS user-gesture restrictions mean programmatically summoning the keyboard is not reliable.
- Geometry arrives after the iOS keyboard animation completes (perceived as up to ~500 ms), unlike native Chromium which fires `geometrychange` during the animation.
- iPad floating and split keyboards, and hardware keyboards, occlude little or nothing, so they report a height of roughly zero.
- The `virtualkeyboardpolicy` attribute is not emulated in v1.
- Rotating the device with the keyboard open re-baselines against keyboard-occluded geometry, so the rect may read zero until the keyboard is dismissed and reopened.
- Desktop and other non-touch devices always report zeros by design. There is no virtual keyboard to measure, and this prevents false positives from window resizes.

## SSR and Node

Every entry is import-safe in Node and during server-side rendering. The `/auto` entry guards on `typeof window` and installs nothing outside a browser. `createVirtualKeyboard()` and `new VirtualKeyboardPolyfill()` construct without a window or document and simply attach no listeners, so importing and instantiating never throws on the server.

## License

MIT (c) Cameron Pak
