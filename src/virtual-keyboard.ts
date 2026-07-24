/**
 * `VirtualKeyboardPolyfill` — an EventTarget-based stand-in for the native
 * `navigator.virtualKeyboard`, mirroring the VirtualKeyboard API shape but
 * reporting geometry derived from `visualViewport` (see `geometry.ts`).
 */

import {
  GeometryEngine,
  createDOMRectReadOnly,
  deepActiveElement,
  isEditableElement,
  type DocumentLike,
  type RectValue,
  type WindowLike,
} from "./geometry.js";
import { writeKeyboardInsetProps, type InsetViewport, type StyleTarget } from "./css-properties.js";

export interface VirtualKeyboardPolyfillOptions {
  /** Window-like source of geometry signals. Defaults to `globalThis.window`. */
  window?: WindowLike;
  /** Document-like source of focus/style. Defaults to `globalThis.document`. */
  document?: DocumentLike & StyleTarget;
  /** Write `--keyboard-inset-*` custom properties on rect change. Default `false`. */
  cssProperties?: boolean;
}

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

    // Ponyfill starts listeners on construction (Rule 8). SSR-safe: without a
    // window/document the engine simply attaches nothing.
    if (this.#win && this.#doc) {
      this.#engine = new GeometryEngine({
        win: this.#win,
        doc: this.#doc,
        onRectChange: (rect) => this.#handleRect(rect),
      });
      this.#engine.start();
    }
  }

  #handleRect(rect: RectValue): void {
    this.#boundingRect = createDOMRectReadOnly(rect.x, rect.y, rect.width, rect.height);
    if (this.#cssProperties && this.#doc && this.#win) {
      writeKeyboardInsetProps(this.#doc, rect, this.#win as InsetViewport);
    }
    this.dispatchEvent(new Event("geometrychange"));
  }

  get boundingRect(): DOMRectReadOnly {
    return this.#boundingRect;
  }

  get overlaysContent(): boolean {
    return this.#overlaysContent;
  }

  set overlaysContent(value: boolean) {
    // Stored flag (decision 8). `true` is a no-op on Safari (already the
    // behavior); `false` is unsupported and documented, but the value is kept.
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

  /** Best-effort refocus of the active editable; silent no-op otherwise (decision 6). */
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

  /** Blur the active editable when one is focused (decision 7). */
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
