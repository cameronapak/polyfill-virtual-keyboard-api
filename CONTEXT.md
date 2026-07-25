# Domain glossary

Terms for the Safari VirtualKeyboard polyfill effort. Vocabulary only — no implementation detail.

## Polyfill

A stand-in for `navigator.virtualKeyboard` that mirrors the W3C VirtualKeyboard API shape on engines that lack the native API. Owns the IDL surface: `boundingRect`, Keyboard insets sync, `geometrychange`, `overlaysContent`, `show` / `hide`. Does not claim full UA power (e.g. cannot resize Safari's layout viewport).

## Native passthrough

When Chromium (or any engine) already implements `navigator.virtualKeyboard`, the package returns that object unchanged and does not install measurement logic.

## Geometry engine

The measurement core that derives keyboard occlusion from `visualViewport` and focus state. Emits Dual metrics for the Polyfill to map onto the IDL surface; is not itself part of that surface.

## Dual metrics

The pair of heights for one keyboard state: physical occlusion (feeds `boundingRect`) and uncovered layout bottom (feeds Keyboard insets). Needed because Safari may scroll-compensate part of the keyboard, so the two can differ.

## Settle filter

A short stability wait before committing a new keyboard height, so mid-animation / mid-transition `visualViewport` noise does not spam `geometrychange` or jump layouts.

## Keyboard insets

The six values (`top` / `right` / `bottom` / `left` / `width` / `height`) that describe the keyboard rectangle relative to the viewport — native as `env(keyboard-inset-*)`, polyfilled as `--keyboard-inset-*` custom properties.

## Recipe

App-facing guidance and optional helpers for a fixed bottom composer on iOS Safari/PWA (pre-lift, `preventScroll`, scroll containment). Uses the Polyfill for height; is not itself part of the VirtualKeyboard API surface.

## attachIosComposer

The v1 Recipe entrypoint (`virtual-keyboard-api-polyfill/ios-composer`): a vanilla function that wires pre-lift, preventScroll focus, gated bar controls, and scoped scroll lock onto a composer element, reading keyboard height from the Keyboard insets height channel (same number CSS uses), with `navigator.virtualKeyboard` as the geometrychange / fallback source.

## Pre-lift

Moving a fixed composer to its keyboard-open position before focus completes, so Safari's pre-focus visibility check does not scroll the document unpredictably.

## Overlays content

The VirtualKeyboard API flag meaning the UA leaves layout/visual viewports alone and the keyboard draws over the page. Safari's default behavior already matches this; the Polyfill stores the flag but cannot emulate the opposite (`false`).

## Measured fixed probe

A zero-size `position: fixed; bottom: 0` element used to read layout-viewport bottom in document-scrolling apps. Lift is `probe.getBoundingClientRect().bottom - visualViewport.height`. Escape hatch when remainder-driven CSS over-lifts because layout viewport bottom ≠ visible band bottom.
