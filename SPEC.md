# virtual-keyboard-api-polyfill — Design Spec

Polyfill contract only. Decisions below are settled; deviations need orchestrator sign-off.

Safari chat-UI shell / pre-lift / focus timing live in the separate **Recipe** — see [`docs/ios-composer.md`](docs/ios-composer.md). This SPEC does not own those behaviors.

## What this is

A polyfill/ponyfill for the [VirtualKeyboard API](https://developer.mozilla.org/en-US/docs/Web/API/VirtualKeyboard_API) (Chromium-only today), targeting Safari/iOS, Firefox, and WKWebView. Safari’s default OSK leaves the **layout** viewport/ICB alone and shrinks the **visual** viewport (`resizes-visual`). That is close to VirtualKeyboard `overlaysContent = true` for layout purposes, but not bit-identical to `interactive-widget=overlays-content` (Safari still resizes VV). The polyfill’s job is to **report keyboard geometry** via the standard API shape, computed from `visualViewport`. Viewport meta `interactive-widget` is complementary UA policy — **not** polyfilled here (Chromium Android honors the meta; Safari cannot).

## Settled decisions

| # | Decision | Choice | Why |
|---|---|---|---|
| 1 | Package name | `virtual-keyboard-api-polyfill` | Discoverable, matches repo |
| 1b | First publish version | `0.0.1` | Soft launch; bump when confident |
| 2 | Shape | Ponyfill core + opt-in global patch | No surprise globals |
| 3 | Runtime deps | Zero | It’s a polyfill |
| 4 | Tooling | TypeScript strict, Bun (`bun test` + happy-dom), tsup (ESM + CJS + d.ts) | Cam’s stack |
| 5 | CSS strategy | JS sets `--keyboard-inset-*` on `:root`; authors hand-write `env(..., var(...))` | `env()` cannot be defined from JS |
| 6 | Dual metrics | `boundingRect` = **trueHeight**; CSS insets = **remainder** | Avoid double-lift when Safari scroll-compensates |
| 7 | Height stability | `HEIGHT_STABILITY_MS = 80`, `HEIGHT_EPSILON_PX = 1` before commit | Skip mid-animation spikes; stacks with 300 ms rebaseline |
| 8 | `show()` / `hide()` | Best-effort refocus / `blur()` on editable | iOS gesture limits |
| 9 | `overlaysContent` | Store only; `false` unsupported | Can’t resize Safari layout viewport |
| 9b | `interactive-widget` | Document only; do not polyfill | UA resize policy; true `resizes-content` impossible from JS on Safari |
| 10 | `virtualKeyboardPolicy` | Out of v1 | Complexity not worth ship bar |
| 11 | Recipe packaging | Separate entry `/ios-composer` (not part of this polyfill contract) | Core stays API-shaped |
| 12 | SSR | All entries import-safe; `/auto` guards on `typeof window` | Robustness |
| 13 | License | MIT, author Cameron Pak | — |

## Package entry points

```
virtual-keyboard-api-polyfill          → ponyfill: createVirtualKeyboard(options?), types
virtual-keyboard-api-polyfill/auto     → side-effect: installs navigator.virtualKeyboard if missing + CSS custom props
virtual-keyboard-api-polyfill/ios-composer → Recipe (not polyfill) — see docs/ios-composer.md
```

- `createVirtualKeyboard()` returns the **native** `navigator.virtualKeyboard` when present, else a `VirtualKeyboardPolyfill` instance.
- `/auto` defines `navigator.virtualKeyboard` only when `!('virtualKeyboard' in navigator)`.
- `/ios-composer` does **not** install the polyfill and is **not** specified here.

## API surface + fidelity (v1)

`VirtualKeyboardPolyfill extends EventTarget`:

| Surface | v1 | Fidelity |
| --- | --- | --- |
| `boundingRect` / `geometrychange` | Ship | VV+focus; **rect height = trueHeight**; zeros when hidden; rAF coalesce + **80 ms height stability**; lag vs Chrome-during-animation documented; do not reproduce Chrome Android overshoot / bad `y` |
| `--keyboard-inset-*` + `env(…, var(…))` | Ship | Spec-true docked insets; **inset height = remainder** when scroll compensation ≠ trueHeight; all `0px` when hidden |
| `overlaysContent` | Ship flag | Store; `true` no-op on Safari; `false` unsupported. Apps should set `true` for Chromium parity |
| `hide()` | Ship | `blur()` active editable |
| `show()` | Ship | Best-effort refocus; no sticky-activation / policy / secure-context theater |
| `virtualKeyboardPolicy` | Defer | Out of v1 |
| Secure-context / sticky-activation | Document | Do not fake UA security boundaries |

Polyfill-only extras (documented): `dispose()`, `readonly isPolyfill: true`.

`boundingRect` shape while open: `{ x: 0, y: innerHeight - h, width: innerWidth, height: h }` (`h` = trueHeight). Document `x`/`y` as approximations; `height` is load-bearing. Support `addEventListener` and `ongeometrychange`.

## Geometry engine rules

Signal source: `visualViewport` `resize` + `scroll`, document `focusin`/`focusout`, window `resize`/`orientationchange`. Listeners passive; updates coalesced through `requestAnimationFrame` (≤1 committed event per frame after filters).

1. **Focus gating**: report occlusion only while a text-editable is focused (`input` of texty types, `textarea`, `[contenteditable]`, including open shadow roots via `activeElement` walk). `focusout` with no editable refocus → zeros immediately (no 80 ms wait).

2. **Dual metrics**: at `focusin` (before keyboard animates), capture `baselineBottom = vv.height + vv.offsetTop` and `baselineHeight = vv.height`. Per frame:
   - **trueHeight** `= max(0, round(baselineHeight - vv.height))` → drives `boundingRect` / `geometrychange` / hide detection.
   - **remainder** `= max(0, round(baselineBottom - vv.height - vv.offsetTop))` → drives CSS custom properties (lift only what the browser has not already revealed).
   When remainder is 0, all six CSS props are `0px`. Baselines are per-focus (never from `window.innerHeight`), held across editable→editable focus, and restored together by the spurious-wobble settle path (Rule 3).

3. **Pinch-zoom / rebaseline** (`SETTLE_DELAY_MS = 300`): guard on scale **change**, not absolute value. Capture `baselineScale` with the baseline. While `|scale - baselineScale| > 0.01`, freeze last rect and schedule settle:
   - **Spurious wobble** (settle with scale back within epsilon and `innerWidth` unchanged): restore frozen baseline.
   - **Genuine change** (new stable scale, or width-change resize / `orientationchange`): clear baselines for fresh capture.
   Re-baseline only on `orientationchange` or window resize where `innerWidth` changed. Height-only window resizes must **not** re-baseline (WKWebView keyboard shrinks `innerHeight`).

4. **Height stability** (`HEIGHT_STABILITY_MS = 80`, `HEIGHT_EPSILON_PX = 1`): before committing a new trueHeight/remainder (and thus `geometrychange` / CSS writes), require candidates to stay within epsilon for 80 ms; restart on change. Stacks with Rule 3 — while resettling, do not advance the stability pipeline. Stability does **not** replace the 300 ms rebaseline. Focusout / non-touch still clear immediately.

5. **Touch gate**: if `navigator.maxTouchPoints === 0`, always report zeros. If unreadable, assume touch-capable.

6. **Hide while focused**: trueHeight &lt; 1 px → hidden (all-zero rect), subject to height stability when transitioning through animation noise.

7. **Floating / split / hardware keyboards**: report measured occlusion (~0). No device whitelists.

8. **CSS custom properties**: when enabled (default in `/auto`; ponyfill option `cssProperties`, default `false` unless opted in), write `--keyboard-inset-top/right/bottom/left/width/height` (px strings) on `document.documentElement` from **remainder**-based docked insets: `height = remainder`, `width = innerWidth`, `left = right = bottom = 0`, `top = innerHeight - remainder`. All `0px` when hidden or fully compensated.

9. **Lifecycle**: ponyfill starts listeners on construction; `dispose()` tears down. `/auto` constructs eagerly.

### Explicit non-goals (geometry)

- Matching Chrome Android mid-animation metric corruption or env-var coord bugs
- Emulating `overlaysContent = false`
- Polyfilling viewport meta `interactive-widget` (incl. `resizes-content`)
- Dual-screen / non-bottom VK
- A second measurement path inside the Recipe

## CSS usage pattern

No build-time tooling. Authors write the fallback chain by hand, for each inset name `X`:

```css
bottom: env(keyboard-inset-height, var(--keyboard-inset-height, 0px));
```

Native `env()` wins on Chromium; polyfilled browsers use the custom property; if JS never ran, the final fallback applies.

## Tests / gates

`bun test` + happy-dom. Mock `visualViewport` and drive scenarios:

1. Classic iOS Safari: `innerHeight` constant, `vv.height` shrinks on focus → rect + `geometrychange` + CSS props.
2. WKWebView both-shrink: `innerHeight` and `vv.height` shrink together → correct via baseline.
3. Dual metrics: scroll-compensated case → non-zero trueHeight, remainder/CSS `0`.
4. Height stability: oscillating heights commit only after ≥80 ms plateau; focusout clears immediately; resettle cancels pending commit.
5. Pinch zoom: scale delta freezes; spurious wobble restores baseline.
6. Blur → zeros + event; editable→editable keeps baseline.
7. `hide()` blurs; `show()` no-throw.
8. `/auto` defines once; respects native; ponyfill passthrough when native exists.
9. Inset consistency: docked band `top + height + bottom === innerHeight`.

### Gates

- `bun test` green
- `bunx tsc --noEmit` clean
- `bun run build` produces dist ESM+CJS+d.ts for package entries
- No runtime dependencies in `package.json`

## Known limitations

- `overlaysContent = false` not emulated
- `show()` best-effort only (iOS user-gesture restriction)
- Geometry commits after height stability (+ animation), so updates lag Chrome-during-animation (perceived up to ~500 ms)
- **No-shrink top / already-visible inputs**: when focus does not shrink VV, occlusion is undetectable → report zeros (hard limit)
- Floating / split / hardware keyboards report ~0 occlusion
- `virtualKeyboardPolicy` not emulated (v1)
- Rotate while keyboard open: rebaseline hole → rect may read zero until dismiss + reopen
- Non-touch devices always report zeros (by design)
- Secure-context / sticky-activation not faked
- Dual-screen / non-bottom VK out of v1
- Recipe behaviors (pre-lift, scroll lock, layout shell) are **not** part of this polyfill — see [`docs/ios-composer.md`](docs/ios-composer.md)
