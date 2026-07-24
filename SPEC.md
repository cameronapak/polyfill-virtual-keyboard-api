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
| 5 | CSS strategy | JS sets `--keyboard-inset-*` custom props on `:root`; authors hand-write the `env(..., var(...))` fallback chain (PostCSS plugin dropped by owner) | `env()` cannot be defined from JS, period. Fallback chain keeps native Chrome behavior intact (see below) |
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
2. **Baseline capture and DUAL metrics (revised 2026-07-24 after simulator evidence)**: at `focusin` (before the keyboard animates in), capture `baselineBottom = vv.height + vv.offsetTop` AND `baselineHeight = vv.height`. Two distinct outputs per frame:
   - **trueHeight** `= max(0, round(baselineHeight - vv.height))` — the physical keyboard size in CSS px. Drives `boundingRect` and `geometrychange` (spec-faithful: Chrome reports the keyboard rect regardless of browser scroll compensation). Rule 5 hide-detection keys off trueHeight.
   - **remainder** `= max(0, round(baselineBottom - vv.height - vv.offsetTop))` — how much of the layout-viewport bottom the browser did NOT already reveal by scrolling/pushing. Drives the CSS custom properties, so bottom-fixed content lifts only by what is still needed (no double-compensation).
   Evidence: iOS 26 Safari at page zoom scrolled vv to `328@294` on a `622` layout (sum exactly 622) — keyboard fully compensated, remainder 0, but a real ~293 px keyboard was up; reporting zeros for boundingRect would be wrong, while lifting CSS by 293 would double-compensate. In WKWebView (no scroll compensation) the two metrics coincide. CSS props when remainder is 0: all six `0px`. This split is a deliberate, documented divergence from the native invariant that env vars mirror the boundingRect.
   Both baselines are captured per-focus (never from `window.innerHeight`), held while focus moves directly between editables, and restored together by the spurious-wobble settle path (Rule 3).
3. **Pinch-zoom guard (revised twice 2026-07-24 after simulator testing)**: guard on scale CHANGE, not absolute value. Capture `baselineScale = visualViewport.scale` alongside the baseline. While `Math.abs(scale - baselineScale) > 0.01`, freeze (keep last rect) and schedule a settle. Critical settle semantics: iOS transiently wobbles `vv.scale` DURING the keyboard-open animation, so a settle that blindly re-captures would latch an occluded baseline and silence the whole focus session. Therefore the settle distinguishes:
   - **Spurious wobble** (settle fires with `|scale_now - baselineScale| <= epsilon` and `innerWidth` unchanged): RESTORE the frozen baseline unchanged and resume reporting against it.
   - **Genuine change** (scale stabilized at a new value, or the settle was requested by a width-change resize / orientationchange): clear baseline + baselineScale for fresh capture on the next frame.
   Re-baseline requests must carry their reason (`scale` vs `geometry`) so the settle can apply the rule above. Rationale for scale-change guarding at all: iOS Safari page zoom (aA menu) holds `vv.scale` at e.g. 1.15 permanently; freezing on `scale != 1` disables the engine entirely for page-zoom users. A stable non-1 scale measures correctly because baseline and current readings share the same CSS-pixel space.
4. **Orientation/window resize**: re-capture the baseline (after a 300 ms settle delay) ONLY on `orientationchange` or a window resize where `innerWidth` changed. Height-only window resizes must NOT re-baseline: in WKWebView the keyboard itself shrinks `window.innerHeight`, so a height-only re-baseline would erase the occlusion being measured. When not focused, baseline is captured fresh on next focus anyway. Known limitation (document): rotating with the keyboard open re-baselines against keyboard-occluded geometry, so the rect may read zero until the keyboard is dismissed and reopened.
4b. **Touch gate**: if `navigator.maxTouchPoints === 0`, always report zeros (no virtual keyboard exists; prevents desktop window-resize false positives). If `maxTouchPoints` is unreadable, assume touch-capable.
5. **Keyboard hide while focused** (user taps the dismiss key): vv grows back to ≈ baseline → occlusion ≈ 0 → report zeros. Threshold: occlusion < 1 px reports as hidden (all-zero rect).
6. **Hardware keyboards / floating / split iPad keyboards**: occlusion is naturally ~0 or small; report whatever is measured. No magic thresholds beyond rule 5 — Chrome native behaves similarly.
7. **CSS custom properties**: when enabled (default in `/auto`; option `cssProperties: boolean` in ponyfill, default `true` when installed globally, `false` for bare ponyfill unless opted in), write `--keyboard-inset-top/right/bottom/left/width/height` (px strings) to `document.documentElement.style` on every rect change. Values mirror what native `env(keyboard-inset-*)` would expose with `overlaysContent = true`: `top = y`, `bottom = 0`... **careful**: native semantics are insets from viewport edges: `keyboard-inset-top = y`, `keyboard-inset-bottom = 0` when docked... Verify against MDN during implementation: insets define the keyboard rectangle: `top`, `right`, `bottom`, `left` are distances such that the keyboard occupies the box. For a docked keyboard: `keyboard-inset-height = h`, `keyboard-inset-bottom = 0` is WRONG if it means distance from bottom... Implementation must match MDN's definition (`keyboard-inset-height` ≈ height; insets are from the layout viewport edges to the keyboard box: left=0, right=0, bottom=0, top=innerHeight - h). Write a unit test asserting `height = top→bottom consistency`.
8. **No listeners until first use**: ponyfill starts listeners on construction; `dispose()` tears down. `/auto` constructs eagerly (that's its point).

## CSS usage pattern (PostCSS plugin dropped by owner decision, 2026-07-24)

No build-time tooling. Authors write the fallback chain by hand, for X ∈ {top,right,bottom,left,width,height}:

```css
bottom: env(keyboard-inset-X, var(--keyboard-inset-X, FALLBACK));
```

Why this shape: browsers with native support resolve `env()` directly (custom property ignored — no double-compensation); browsers without it use the fallback, which resolves to the polyfill's custom property; if JS never ran, the original FALLBACK (or 0px) still applies. Document this pattern prominently in the README.

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
