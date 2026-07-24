/**
 * `VirtualKeyboardPolyfill` — deep IDL-shaped stand-in for native
 * `navigator.virtualKeyboard`. Owns one geometry commit step: update
 * `boundingRect`, sync Keyboard insets, fire `geometrychange`. Dual metrics
 * (trueHeight vs remainder) stay inside that step — not on the public interface.
 */

import {
  GeometryEngine,
  createDOMRectReadOnly,
  deepActiveElement,
  isEditableElement,
  type DocumentLike,
  type GeometrySnapshot,
  type RectValue,
  type WindowLike,
} from "./geometry.js";
import { writeKeyboardInsetProps, type InsetViewport, type StyleTarget } from "./css-properties.js";

export type VirtualKeyboardPolyfillOptions = {
  /** Window-like source of geometry signals. Defaults to `globalThis.window`. */
  window?: WindowLike;
  /** Document-like source of focus/style. Defaults to `globalThis.document`. */
  document?: DocumentLike & StyleTarget;
  /** Write `--keyboard-inset-*` custom properties on geometry commit. Default `false`. */
  cssProperties?: boolean;
};

type GeometryChangeHandler = ((this: VirtualKeyboardPolyfill, ev: Event) => unknown) | null;

const EMPTY_RECT: RectValue = { x: 0, y: 0, width: 0, height: 0 };

function resolveWindow(explicit: WindowLike | undefined): WindowLike | undefined {
  if (explicit) return explicit;
  if (typeof globalThis !== "undefined") {
    const g = globalThis as { window?: WindowLike };
    if (g.window) return g.window;
  }
  return undefined;
}

function resolveDocument(
  explicit: (DocumentLike & StyleTarget) | undefined,
): (DocumentLike & StyleTarget) | undefined {
  if (explicit) return explicit;
  if (typeof globalThis !== "undefined") {
    const g = globalThis as { document?: DocumentLike & StyleTarget };
    if (g.document) return g.document;
  }
  return undefined;
}

export class VirtualKeyboardPolyfill extends EventTarget {
  /** Discriminator so callers can tell the polyfill from the native object. */
  readonly isPolyfill = true as const;

  #win: WindowLike | undefined;
  #doc: (DocumentLike & StyleTarget) | undefined;
  #cssProperties: boolean;
  #engine: GeometryEngine | null = null;

  #overlaysContent = false;
  #boundingRect: DOMRectReadOnly = createDOMRectReadOnly(0, 0, 0, 0);
  #ongeometrychange: GeometryChangeHandler = null;

  constructor(options: VirtualKeyboardPolyfillOptions = {}) {
    super();
    this.#win = resolveWindow(options.window);
    this.#doc = resolveDocument(options.document);
    this.#cssProperties = options.cssProperties ?? false;

    // Ponyfill starts listeners on construction. SSR-safe: without a
    // window/document the engine simply attaches nothing.
    if (this.#win && this.#doc) {
      this.#engine = new GeometryEngine({
        win: this.#win,
        doc: this.#doc,
        onCommit: (snapshot) => this.#commitGeometry(snapshot),
      });
      this.#engine.start();
    }
  }

  /**
   * One UA-like geometry step: boundingRect → optional Keyboard insets →
   * geometrychange. Remainder never leaves this method.
   */
  #commitGeometry(snapshot: GeometrySnapshot): void {
    const { rect, remainder } = snapshot;
    this.#boundingRect = createDOMRectReadOnly(rect.x, rect.y, rect.width, rect.height);
    this.#syncKeyboardInsets(remainder);
    this.dispatchEvent(new Event("geometrychange"));
  }

  /** Native-shaped inset sync: maps internal remainder onto `--keyboard-inset-*`. */
  #syncKeyboardInsets(remainder: number): void {
    if (!this.#cssProperties || !this.#doc || !this.#win) return;
    writeKeyboardInsetProps(this.#doc, remainder, this.#win as InsetViewport);
  }

  get boundingRect(): DOMRectReadOnly {
    return this.#boundingRect;
  }

  get overlaysContent(): boolean {
    return this.#overlaysContent;
  }

  set overlaysContent(value: boolean) {
    // Stored flag. `true` is a no-op on Safari (already the behavior);
    // `false` is unsupported and documented, but the value is kept.
    this.#overlaysContent = Boolean(value);
  }

  get ongeometrychange(): GeometryChangeHandler {
    return this.#ongeometrychange;
  }

  set ongeometrychange(handler: GeometryChangeHandler) {
    if (this.#ongeometrychange) {
      this.removeEventListener("geometrychange", this.#ongeometrychange as EventListener);
    }
    this.#ongeometrychange = typeof handler === "function" ? handler : null;
    if (this.#ongeometrychange) {
      this.addEventListener("geometrychange", this.#ongeometrychange as EventListener);
    }
  }

  /** Best-effort refocus of the active editable; silent no-op otherwise. */
  show(): undefined {
    if (!this.#doc) return undefined;
    const active = deepActiveElement(this.#doc);
    if (isEditableElement(active) && active && typeof active.focus === "function") {
      try {
        active.focus();
      } catch {
        // iOS user-gesture restrictions make this unreliable; swallow.
      }
    }
    return undefined;
  }

  /** Blur the active editable when one is focused. */
  hide(): undefined {
    if (!this.#doc) return undefined;
    const active = deepActiveElement(this.#doc);
    if (isEditableElement(active) && active && typeof active.blur === "function") {
      try {
        active.blur();
      } catch {
        // swallow
      }
    }
    return undefined;
  }

  /** Polyfill-only: tear down listeners. */
  dispose(): void {
    if (this.#ongeometrychange) {
      this.removeEventListener("geometrychange", this.#ongeometrychange as EventListener);
      this.#ongeometrychange = null;
    }
    if (this.#engine) {
      this.#engine.stop();
      this.#engine = null;
    }
    this.#boundingRect = createDOMRectReadOnly(
      EMPTY_RECT.x,
      EMPTY_RECT.y,
      EMPTY_RECT.width,
      EMPTY_RECT.height,
    );
  }
}
