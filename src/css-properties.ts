/**
 * Writes the `--keyboard-inset-*` CSS custom properties that mirror the native
 * `env(keyboard-inset-*)` environment variables.
 *
 * Verified semantics (MDN "VirtualKeyboard API", W3C Virtual Keyboard API
 * spec §5.1, fetched 2026-07-24):
 *
 *   "The keyboard insets are six environment variables that define a rectangle
 *    by its top, right, bottom, and left insets from the edge of the viewport."
 *   (W3C). MDN: they "define a rectangle by its top, right, bottom, and left
 *   insets from the edge of the viewport. The width and height variables are
 *   also available if needed." Defaults are `0px` when no keyboard is shown.
 *
 * So each inset is the distance from a viewport edge to the corresponding edge
 * of the keyboard box. The CSS props describe a bottom-docked band of height
 * `remainder`:
 *
 *   keyboard-inset-top    = innerHeight - remainder
 *   keyboard-inset-right  = 0
 *   keyboard-inset-bottom = 0
 *   keyboard-inset-left   = 0
 *   keyboard-inset-width  = innerWidth
 *   keyboard-inset-height = remainder
 *
 * When `remainder` is 0 all six values are `0px`, matching the native defaults.
 *
 * DELIBERATE, DOCUMENTED DIVERGENCE (Rule 2 dual metrics): the CSS props are
 * driven by `remainder` (the layout bottom the browser did NOT already reveal
 * by scrolling the visual viewport), NOT by `boundingRect.height`. Natively the
 * env vars mirror the boundingRect exactly; here they can differ. Rationale:
 * on iOS the browser often scroll-compensates part or all of the keyboard, so
 * lifting bottom-fixed content by the full physical keyboard height would
 * double-compensate. `remainder` lifts CSS by only what is still needed, while
 * `boundingRect` keeps reporting the true physical keyboard size to JS.
 */

export interface InsetViewport {
  readonly innerWidth: number;
  readonly innerHeight: number;
}

export interface KeyboardInsets {
  top: number;
  right: number;
  bottom: number;
  left: number;
  width: number;
  height: number;
}

/** Minimal target: `document.documentElement.style`. */
export interface StyleTarget {
  readonly documentElement: {
    readonly style: {
      setProperty(property: string, value: string): void;
    };
  } | null;
}

const INSET_PROPERTIES = ["top", "right", "bottom", "left", "width", "height"] as const;

/**
 * Derive the six keyboard insets from the `remainder` (uncovered layout bottom
 * in px) and the viewport size. A remainder of 0 yields all zeros, matching
 * native defaults.
 */
export function computeInsets(remainder: number, viewport: InsetViewport): KeyboardInsets {
  if (remainder <= 0) {
    return { top: 0, right: 0, bottom: 0, left: 0, width: 0, height: 0 };
  }
  return {
    top: Math.max(0, viewport.innerHeight - remainder),
    right: 0,
    bottom: 0,
    left: 0,
    width: viewport.innerWidth,
    height: remainder,
  };
}

/**
 * Write `--keyboard-inset-{top,right,bottom,left,width,height}` (px strings) to
 * the document element. Called only from VirtualKeyboard's geometry commit —
 * not a public package seam.
 */
export function writeKeyboardInsetProps(
  doc: StyleTarget,
  remainder: number,
  viewport: InsetViewport,
): void {
  const style = doc.documentElement?.style;
  if (!style) return;
  const insets = computeInsets(remainder, viewport);
  for (const prop of INSET_PROPERTIES) {
    style.setProperty(`--keyboard-inset-${prop}`, `${insets[prop]}px`);
  }
}
