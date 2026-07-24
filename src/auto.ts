/**
 * Side-effect entry. Installs `navigator.virtualKeyboard` (with CSS custom
 * properties enabled) when the browser lacks native support. Import for effect:
 *
 *   import "virtual-keyboard-api-polyfill/auto";
 *
 * SSR-safe: does nothing outside a browser. The installed instance is also the
 * default export for debuggability (undefined when not installed).
 */

import { VirtualKeyboardPolyfill } from "./virtual-keyboard.js";

let installed: VirtualKeyboardPolyfill | undefined;

if (typeof window !== "undefined" && typeof navigator !== "undefined") {
  if (!("virtualKeyboard" in navigator)) {
    const instance = new VirtualKeyboardPolyfill({ cssProperties: true });
    try {
      Object.defineProperty(navigator, "virtualKeyboard", {
        value: instance,
        configurable: true,
        enumerable: true,
      });
      installed = instance;
    } catch {
      // Some environments make `navigator` non-extensible; leave uninstalled.
      instance.dispose();
    }
  }
}

export default installed;
