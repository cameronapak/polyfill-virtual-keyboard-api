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
 * of the keyboard box. For a docked keyboard with `overlaysContent = true`,
 * described by boundingRect `{x:0, y: innerHeight - h, width: innerWidth,
 * height: h}`:
 *
 *   keyboard-inset-top    = y                  ( = innerHeight - h )
 *   keyboard-inset-right  = innerWidth  - (x + width)   = 0
 *   keyboard-inset-bottom = innerHeight - (y + height)  = 0
 *   keyboard-inset-left   = x                            = 0
 *   keyboard-inset-width  = width               ( = innerWidth )
 *   keyboard-inset-height = height              ( = h )
 *
 * Consistency: top + height + bottom === innerHeight (Rule 7 unit invariant).
 * When the keyboard is hidden (empty rect) all six values are `0px`, matching
 * the native defaults.
 */

import type { RectValue } from "./geometry.js";

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
 * Derive the six keyboard insets from a boundingRect and the viewport size.
 * An empty rect (hidden keyboard) yields all zeros, matching native defaults.
 */
export function computeInsets(rect: RectValue, viewport: InsetViewport): KeyboardInsets {
  if (rect.width === 0 && rect.height === 0) {
    return { top: 0, right: 0, bottom: 0, left: 0, width: 0, height: 0 };
  }
  return {
    top: rect.y,
    right: Math.max(0, viewport.innerWidth - (rect.x + rect.width)),
    bottom: Math.max(0, viewport.innerHeight - (rect.y + rect.height)),
    left: rect.x,
    width: rect.width,
    height: rect.height,
  };
}

/**
 * Write `--keyboard-inset-{top,right,bottom,left,width,height}` (px strings) to
 * the document element on every rect change.
 */
export function writeKeyboardInsetProps(
  doc: StyleTarget,
  rect: RectValue,
  viewport: InsetViewport,
): void {
  const style = doc.documentElement?.style;
  if (!style) return;
  const insets = computeInsets(rect, viewport);
  for (const prop of INSET_PROPERTIES) {
    style.setProperty(`--keyboard-inset-${prop}`, `${insets[prop]}px`);
  }
}
