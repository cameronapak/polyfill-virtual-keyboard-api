/**
 * Ponyfill entry. `createVirtualKeyboard()` returns the native
 * `navigator.virtualKeyboard` when present (passthrough), otherwise a
 * `VirtualKeyboardPolyfill` instance. Importing this module has no side effects
 * and is safe in SSR / bare Node.
 */

import {
  VirtualKeyboardPolyfill,
  type VirtualKeyboardPolyfillOptions,
} from "./virtual-keyboard.js";

export { VirtualKeyboardPolyfill };
export type { VirtualKeyboardPolyfillOptions };

export type {
  RectValue,
  WindowLike,
  DocumentLike,
  ElementLike,
  VisualViewportLike,
} from "./geometry.js";
export type {
  KeyboardInsets,
  InsetViewport,
  StyleTarget,
} from "./css-properties.js";

export interface CreateVirtualKeyboardOptions extends VirtualKeyboardPolyfillOptions {
  /**
   * Navigator to probe for a native `virtualKeyboard`. Defaults to
   * `globalThis.navigator`. Pass a fake for testing the passthrough path.
   */
  navigator?: { virtualKeyboard?: unknown } & Record<string, unknown>;
}

/** The subset of the native VirtualKeyboard surface the polyfill mirrors. */
export interface VirtualKeyboardLike {
  readonly boundingRect: DOMRectReadOnly;
  overlaysContent: boolean;
  show(): undefined;
  hide(): undefined;
  addEventListener(type: string, listener: EventListenerOrEventListenerObject | null): void;
  removeEventListener(type: string, listener: EventListenerOrEventListenerObject | null): void;
}

function resolveNavigator(
  explicit: CreateVirtualKeyboardOptions["navigator"],
): ({ virtualKeyboard?: unknown } & Record<string, unknown>) | undefined {
  if (explicit) return explicit;
  if (typeof globalThis !== "undefined") {
    const g = globalThis as unknown as {
      navigator?: { virtualKeyboard?: unknown } & Record<string, unknown>;
    };
    if (g.navigator) return g.navigator;
  }
  return undefined;
}

/**
 * Return the native `navigator.virtualKeyboard` if the browser implements it,
 * else a fresh `VirtualKeyboardPolyfill`. Never throws in SSR / bare Node.
 */
export function createVirtualKeyboard(
  options: CreateVirtualKeyboardOptions = {},
): VirtualKeyboardLike | VirtualKeyboardPolyfill {
  const { navigator: navOption, ...polyfillOptions } = options;
  const nav = resolveNavigator(navOption);
  if (nav && "virtualKeyboard" in nav && nav.virtualKeyboard) {
    return nav.virtualKeyboard as VirtualKeyboardLike;
  }
  return new VirtualKeyboardPolyfill(polyfillOptions);
}
