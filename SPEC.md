# virtual-keyboard-api-polyfill — Design Spec

Contract for implementation. Decisions below are settled; deviations require orchestrator sign-off.

## What this is

A polyfill/ponyfill for the [VirtualKeyboard API](https://developer.mozilla.org/en-US/docs/Web/API/VirtualKeyboard_API) (Chromium-only today), targeting Safari/iOS, Firefox, and WKWebView. Core insight: Safari's default keyboard behavior already matches `overlaysContent = true` (keyboard overlays the page; only the visual viewport shrinks). So the polyfill's job is to **report keyboard geometry** via the standard API shape, computed from `visualViewport`.

## Settled decisions

| # | Decision | Choice | Why |
|---|---|---|---|
| 1 | Package name | `virtual-keyboard-api-polyfill` (npm 404 = available, verified 2026-07-24) | Discoverable, matches repo |
| 2 | Shape | Ponyfill core + opt-in global patch | Best practice (cf. resize-observer-polyfill); no surprise globals |
| 3 | Runtime deps | Zero | It's a polyfill |
| 4 | Tooling | TypeScript strict, Bun for dev/test (`bun test` + happy-dom), tsup for build (ESM + CJS + d.ts) | Cam's stack (Bun/TS); tsup is boring and reliable |
| 5 | CSS strategy | JS sets `--keyboard-inset-*` custom props on `:root`; PostCSS plugin rewrites `env()` to include a `var()` fallback | `env()` cannot be defined from JS, period. Fallback chain keeps native Chrome behavior intact (see below) |
| 6 | `show()` | Best-effort refocus of active editable; silent no-op otherwise | iOS gesture restrictions make full spec impossible |
| 7 | `hide()` | `document.activeElement.blur()` when editable focused | Works everywhere |
| 8 | `overlaysContent` | Stored getter/setter; `true` is a no-op on Safari (already the behavior); `false` unsupported, documented | Can't resize Safari's layout viewport reliably |
| 9 | `virtualkeyboardpolicy` attribute | Out of scope v1; documented limitation | MutationObserver + focus interception complexity not worth it yet |
| 10 | SSR | All entries import-safe in Node; `/auto` guards on `typeof window` | Robustness |
| 11 | License | MIT, author Cameron Pak | — |

## Package entry points

```
virtual-keyboard-api-polyfill          → ponyfill: createVirtualKeyboard(options?), types
virtual-keyboard-api-polyfill/auto     → side-effect: installs navigator.virtualKeyboard if missing + starts CSS custom props
virtual-keyboard-api-polyfill/postcss  → PostCSS plugin (postcss is optional peer dep)
```

- `createVirtualKeyboard()` returns the **native** `navigator.virtualKeyboard` when present (passthrough), else a `VirtualKeyboardPolyfill` instance.
- `/auto` uses `Object.defineProperty(Navigator.prototype or navigator, 'virtualKeyboard', ...)` only when `!('virtualKeyboard' in navigator)`.

## API surface (mirror the spec)

`VirtualKeyboardPolyfill extends EventTarget`:

- `boundingRect: DOMRectReadOnly` — `{x: 0, y: innerHeight - h, width: innerWidth, height: h}`; all zeros when hidden (matches Chrome). Document x/y as approximations.
- `overlaysContent: boolean` — stored flag (see decision 8).
- `show(): undefined`, `hide(): undefined` — per decisions 6/7.
- `geometrychange` event — `Event` with `target` = the instance; fired whenever the rect changes (including hide → zeros). Support both `addEventListener` and `ongeometrychange` property.
- Extra (polyfill-only, documented): `dispose()` to remove listeners; `readonly isPolyfill: true`.

## Geometry engine rules (the hard part)

Signal source: `visualViewport` `resize` + `scroll`, `focusin`/`focusout` on document, `window` `resize`/`orientationchange`. All listeners passive; updates coalesced through `requestAnimationFrame` (max one event per frame).

1. **Focus gating**: keyboard occlusion is only reported while a text-editable element is focused (`input` of texty types, `textarea`, `[contenteditable]`, or inside an open shadow root — use `document.activeElement` walk through `shadowRoot.activeElement`). On `focusout` with no editable refocus → rect goes to zeros. This kills false positives from URL-bar collapse/expand.
2. **Baseline capture**: at `focusin` (before the keyboard animates in), capture `baseline = visualViewport.height + visualViewport.offsetTop`. Occlusion = `max(0, round(baseline - visualViewport.height - visualViewport.offsetTop))`. This works in BOTH classic iOS Safari (innerHeight constant) and WKWebView/Capacitor (innerHeight and vv.height shrink together), because the baseline is captured per-focus rather than derived from `window.innerHeight`. Keep the baseline while focus moves directly between editables (keyboard stays open).
3. **Pinch-zoom guard**: if `Math.abs(visualViewport.scale - 1) > 0.01`, freeze updates (keep last rect) until scale returns to ~1.
4. **Orientation/window resize**: re-capture the baseline (after a 300 ms settle delay) ONLY on `orientationchange` or a window resize where `innerWidth` changed. Height-only window resizes must NOT re-baseline: in WKWebView the keyboard itself shrinks `window.innerHeight`, so a height-only re-baseline would erase the occlusion being measured. When not focused, baseline is captured fresh on next focus anyway. Known limitation (document): rotating with the keyboard open re-baselines against keyboard-occluded geometry, so the rect may read zero until the keyboard is dismissed and reopened.
4b. **Touch gate**: if `navigator.maxTouchPoints === 0`, always report zeros (no virtual keyboard exists; prevents desktop window-resize false positives). If `maxTouchPoints` is unreadable, assume touch-capable.
5. **Keyboard hide while focused** (user taps the dismiss key): vv grows back to ≈ baseline → occlusion ≈ 0 → report zeros. Threshold: occlusion < 1 px reports as hidden (all-zero rect).
6. **Hardware keyboards / floating / split iPad keyboards**: occlusion is naturally ~0 or small; report whatever is measured. No magic thresholds beyond rule 5 — Chrome native behaves similarly.
7. **CSS custom properties**: when enabled (default in `/auto`; option `cssProperties: boolean` in ponyfill, default `true` when installed globally, `false` for bare ponyfill unless opted in), write `--keyboard-inset-top/right/bottom/left/width/height` (px strings) to `document.documentElement.style` on every rect change. Values mirror what native `env(keyboard-inset-*)` would expose with `overlaysContent = true`: `top = y`, `bottom = 0`... **careful**: native semantics are insets from viewport edges: `keyboard-inset-top = y`, `keyboard-inset-bottom = 0` when docked... Verify against MDN during implementation: insets define the keyboard rectangle: `top`, `right`, `bottom`, `left` are distances such that the keyboard occupies the box. For a docked keyboard: `keyboard-inset-height = h`, `keyboard-inset-bottom = 0` is WRONG if it means distance from bottom... Implementation must match MDN's definition (`keyboard-inset-height` ≈ height; insets are from the layout viewport edges to the keyboard box: left=0, right=0, bottom=0, top=innerHeight - h). Write a unit test asserting `height = top→bottom consistency`.
8. **No listeners until first use**: ponyfill starts listeners on construction; `dispose()` tears down. `/auto` constructs eagerly (that's its point).

## PostCSS plugin

Transform, for X ∈ {top,right,bottom,left,width,height}:

- `env(keyboard-inset-X)` → `env(keyboard-inset-X, var(--keyboard-inset-X, 0px))`
- `env(keyboard-inset-X, FALLBACK)` → `env(keyboard-inset-X, var(--keyboard-inset-X, FALLBACK))`

Why this shape: browsers with native support resolve `env()` directly (custom property ignored — no double-compensation); browsers without it use the fallback, which resolves to the polyfill's custom property; if JS never ran, the original FALLBACK (or 0px) still applies. Must handle: multiple env() in one declaration, nested parens in fallbacks, case-insensitivity, already-transformed values (idempotency — skip if fallback already starts with `var(--keyboard-inset-`).

Plugin options: `{ properties?: string[] }` (default all six). Keep it minimal.

## Tests (bun test + happy-dom)

Mock `visualViewport` (tiny EventTarget stub) and drive scenarios:

1. Classic iOS Safari: innerHeight constant, vv.height shrinks on focus → rect reported, geometrychange fired, custom props set.
2. WKWebView both-shrink: innerHeight AND vv.height shrink together → still correct via baseline capture.
3. Pinch zoom: scale 2 → updates frozen.
4. Blur → zeros + event.
5. Focus moves editable → editable: baseline retained, no flicker to zeros (implementation: treat focusout+focusin in same frame as continuous).
6. hide() blurs; show() no-throw.
7. `/auto`: defines navigator.virtualKeyboard once; respects existing native.
8. Ponyfill returns native passthrough when `navigator.virtualKeyboard` exists.
9. PostCSS: all transform cases incl. idempotency, fallback with nested parens, multiple env() per value.
10. Inset consistency test from geometry rule 7.

## Demo page

`demo/index.html` — zero-build vanilla page: a chat-style layout with bottom-fixed composer using `env(keyboard-inset-height, var(--keyboard-inset-height, 0px))`, a live readout of boundingRect + event log. Must be openable via `bunx serve` or any static server on a phone for on-device verification.

## Gates

- `bun test` green
- `bunx tsc --noEmit` clean
- `bun run build` (tsup) produces dist ESM+CJS+d.ts for all three entries
- No runtime dependencies in package.json

## Known limitations (document in README)

- `overlaysContent = false` not emulated
- `show()` best-effort only (iOS user-gesture restriction)
- Geometry updates arrive after iOS keyboard animation completes (~up to 500 ms perceived), unlike Chrome native which fires during
- iPad floating/split keyboards and hardware keyboards report ~0 occlusion
- `virtualkeyboardpolicy` attribute not emulated (v1)
