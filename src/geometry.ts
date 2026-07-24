/**
 * Geometry engine: derives VirtualKeyboard occlusion geometry from
 * `visualViewport`, focus state, and window resize/orientation signals.
 *
 * The engine is a standalone, dependency-injected unit so tests can drive it
 * with a fake `visualViewport`. Callers pass `win`/`doc` explicitly; defaulting
 * to `globalThis` happens at the call site (see `virtual-keyboard.ts`), never
 * inside the engine.
 */

/** A plain, structurally-cloneable rect. Consumers wrap it as DOMRectReadOnly. */
export interface RectValue {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Minimal `VisualViewport` surface the engine reads. */
export interface VisualViewportLike {
  readonly width: number;
  readonly height: number;
  readonly offsetTop: number;
  readonly offsetLeft: number;
  readonly scale: number;
  addEventListener?(type: string, listener: (ev?: unknown) => void, options?: unknown): void;
  removeEventListener?(type: string, listener: (ev?: unknown) => void, options?: unknown): void;
}

/** Minimal element surface used for focus/editability detection. */
export interface ElementLike {
  readonly tagName?: string;
  readonly type?: string;
  readonly isContentEditable?: boolean;
  readonly shadowRoot?: { readonly activeElement: ElementLike | null } | null;
  focus?(): void;
  blur?(): void;
}

/** Minimal `Window` surface the engine reads. Members are optional for SSR. */
export interface WindowLike {
  readonly innerWidth: number;
  readonly innerHeight: number;
  readonly visualViewport?: VisualViewportLike | null;
  /** Used for the touch gate (Rule 4b). Injectable for tests. */
  readonly navigator?: { readonly maxTouchPoints?: number };
  addEventListener?(type: string, listener: (ev?: unknown) => void, options?: unknown): void;
  removeEventListener?(type: string, listener: (ev?: unknown) => void, options?: unknown): void;
  requestAnimationFrame?(cb: () => void): number;
  cancelAnimationFrame?(handle: number): void;
  setTimeout?: (cb: () => void, ms?: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
}

/** Minimal `Document` surface the engine reads. */
export interface DocumentLike {
  readonly activeElement: ElementLike | null;
  addEventListener?(type: string, listener: (ev?: unknown) => void, options?: unknown): void;
  removeEventListener?(type: string, listener: (ev?: unknown) => void, options?: unknown): void;
}

export interface GeometryEngineDeps {
  win: WindowLike;
  doc: DocumentLike;
  /**
   * Invoked when either reported metric changes. `rect` is the physical keyboard
   * rectangle (drives boundingRect + geometrychange). `remainder` is the
   * still-uncovered layout bottom in px (drives the CSS custom properties only).
   * See the Rule 2 dual-metrics note.
   */
  onRectChange: (rect: RectValue, remainder: number) => void;
}

const ZERO_RECT: RectValue = { x: 0, y: 0, width: 0, height: 0 };

/** Rule 5: occlusion below this many px reports as hidden (all-zero rect). */
const HIDE_THRESHOLD_PX = 1;
/** Rule 3: freeze updates while |scale - 1| exceeds this (pinch-zoom guard). */
const PINCH_EPSILON = 0.01;
/** Rule 4: settle delay before re-capturing baseline after resize/orientation. */
const SETTLE_DELAY_MS = 300;

/** input `type` values that never summon a text keyboard. `select` is excluded entirely. */
const NON_EDITABLE_INPUT_TYPES = new Set([
  "button",
  "checkbox",
  "radio",
  "range",
  "color",
  "file",
  "submit",
  "reset",
  "image",
  "hidden",
]);

/**
 * Walk `document.activeElement` down through open shadow roots to the deepest
 * focused element, so focus inside a web component is detected correctly.
 */
export function deepActiveElement(doc: DocumentLike): ElementLike | null {
  let active: ElementLike | null = doc.activeElement;
  while (active && active.shadowRoot && active.shadowRoot.activeElement) {
    active = active.shadowRoot.activeElement;
  }
  return active;
}

/**
 * Editable = a text-summoning control: `input` of a texty type, `textarea`, or
 * any element with `isContentEditable`. Native `select` is intentionally NOT
 * editable (it opens a picker on iOS, not a text keyboard).
 */
export function isEditableElement(el: ElementLike | null): boolean {
  if (!el) return false;
  if (el.isContentEditable === true) return true;
  const tag = el.tagName ? el.tagName.toLowerCase() : "";
  if (tag === "textarea") return true;
  if (tag === "input") {
    const type = (el.type ? el.type : "text").toLowerCase();
    return !NON_EDITABLE_INPUT_TYPES.has(type);
  }
  return false;
}

/** Build a DOMRectReadOnly, falling back to a frozen plain object where the constructor is absent. */
export function createDOMRectReadOnly(
  x: number,
  y: number,
  width: number,
  height: number,
): DOMRectReadOnly {
  if (typeof DOMRectReadOnly !== "undefined") {
    return new DOMRectReadOnly(x, y, width, height);
  }
  const top = y;
  const left = x;
  const right = x + width;
  const bottom = y + height;
  const rect = {
    x,
    y,
    width,
    height,
    top,
    right,
    bottom,
    left,
    toJSON() {
      return { x, y, width, height, top, right, bottom, left };
    },
  };
  return Object.freeze(rect) as unknown as DOMRectReadOnly;
}

function rectsEqual(a: RectValue, b: RectValue): boolean {
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}

export class GeometryEngine {
  #win: WindowLike;
  #doc: DocumentLike;
  #onRectChange: (rect: RectValue, remainder: number) => void;

  #started = false;
  #disposed = false;

  /**
   * Rule 2 dual baselines, captured together at focus, cleared/restored together.
   * `baselineBottom = vv.height + vv.offsetTop` drives the CSS remainder;
   * `baselineHeight = vv.height` drives the physical keyboard rect. Null when
   * unfocused; `baselineHeight === null` is the "not captured" sentinel.
   */
  #baselineBottom: number | null = null;
  #baselineHeight: number | null = null;
  /** Scale captured alongside the baseline; occlusion is measured relative to it (Rule 3). */
  #baselineScale: number | null = null;
  #lastRect: RectValue = ZERO_RECT;
  #lastRemainder = 0;

  #frameScheduled = false;
  #frameHandle: unknown = null;
  #frameUsesRaf = false;

  /** Rule 4: freeze reporting while a resize/orientation settle timer is pending. */
  #resettling = false;
  #settleHandle: unknown = null;
  /** Rule 4: last-seen innerWidth, to distinguish rotation from height-only resizes. */
  #lastInnerWidth = 0;

  constructor(deps: GeometryEngineDeps) {
    this.#win = deps.win;
    this.#doc = deps.doc;
    this.#onRectChange = deps.onRectChange;
  }

  get currentRect(): RectValue {
    return this.#lastRect;
  }

  start(): void {
    if (this.#started || this.#disposed) return;
    this.#started = true;
    this.#lastInnerWidth = this.#win.innerWidth;

    const vv = this.#win.visualViewport;
    this.#addListener(vv, "resize", this.#onViewportChange);
    this.#addListener(vv, "scroll", this.#onViewportChange);
    this.#addListener(this.#win, "resize", this.#onWindowResize);
    this.#addListener(this.#win, "orientationchange", this.#onOrientationChange);
    this.#addListener(this.#doc, "focusin", this.#onFocusChange);
    this.#addListener(this.#doc, "focusout", this.#onFocusChange);

    // Seed the initial rect (typically zeros; emits nothing since lastRect is zeros).
    this.#scheduleFrame();
  }

  stop(): void {
    if (!this.#started) {
      this.#disposed = true;
      return;
    }
    this.#started = false;
    this.#disposed = true;

    const vv = this.#win.visualViewport;
    this.#removeListener(vv, "resize", this.#onViewportChange);
    this.#removeListener(vv, "scroll", this.#onViewportChange);
    this.#removeListener(this.#win, "resize", this.#onWindowResize);
    this.#removeListener(this.#win, "orientationchange", this.#onOrientationChange);
    this.#removeListener(this.#doc, "focusin", this.#onFocusChange);
    this.#removeListener(this.#doc, "focusout", this.#onFocusChange);

    this.#cancelFrame();
    this.#cancelSettle();
  }

  #onViewportChange = (): void => {
    this.#scheduleFrame();
  };

  // focusin and focusout both route here. We never zero eagerly on focusout;
  // the frame reads the live deep-active element, so a focusout immediately
  // followed by a focusin (moving between editables) coalesces into one frame
  // that still sees an editable and keeps the baseline (Rule 5 flicker guard).
  #onFocusChange = (): void => {
    this.#scheduleFrame();
  };

  #onWindowResize = (): void => {
    // Rule 4: re-baseline only when innerWidth changed (a rotation-like resize).
    // A height-only window resize in WKWebView is the keyboard itself shrinking
    // window.innerHeight; re-baselining there would erase the occlusion we are
    // measuring. So a height-only resize just schedules a frame.
    const widthChanged = this.#win.innerWidth !== this.#lastInnerWidth;
    this.#lastInnerWidth = this.#win.innerWidth;
    if (widthChanged) {
      this.#requestRebaseline("geometry");
    }
    this.#scheduleFrame();
  };

  #onOrientationChange = (): void => {
    this.#lastInnerWidth = this.#win.innerWidth;
    this.#requestRebaseline("geometry");
    this.#scheduleFrame();
  };

  // Rule 3/4: re-capture the baseline after a 300 ms settle delay. `reason`
  // distinguishes a scale-divergence freeze from a width/orientation change so
  // the settle can tell a spurious mid-animation scale wobble (iOS parks
  // vv.scale transiently while the keyboard animates in) from a genuine change.
  // Only editables (baseline set) need this; when unfocused the baseline is
  // captured fresh on the next focus anyway.
  #requestRebaseline(reason: "scale" | "geometry"): void {
    if (this.#baselineHeight === null) return;
    this.#cancelSettle();
    // Snapshot the frozen state at request time. The baselines are not mutated
    // while frozen, so repeated wobble frames that restart the settle re-capture
    // the SAME original baselines rather than an occluded mid-animation value.
    const frozenBottom = this.#baselineBottom;
    const frozenHeight = this.#baselineHeight;
    const frozenScale = this.#baselineScale;
    const frozenWidth = this.#win.innerWidth;
    const run = () => {
      this.#settleHandle = null;
      this.#resettling = false;
      const vv = this.#win.visualViewport;
      const scaleNow = vv ? vv.scale : frozenScale;
      const widthUnchanged = this.#win.innerWidth === frozenWidth;
      const scaleStable =
        frozenScale !== null &&
        scaleNow !== null &&
        Math.abs(scaleNow - frozenScale) <= PINCH_EPSILON;
      if (reason === "scale" && scaleStable && widthUnchanged) {
        // Rule 3 spurious wobble: scale returned to the frozen baseline and the
        // layout did not change -> restore the original baselines untouched and
        // let the frame report correct occlusion against them.
        this.#baselineBottom = frozenBottom;
        this.#baselineHeight = frozenHeight;
        this.#baselineScale = frozenScale;
      } else {
        // Genuine change (scale stabilized at a new value, or a geometry
        // request) -> clear for a fresh capture on the next frame.
        this.#baselineBottom = null;
        this.#baselineHeight = null;
        this.#baselineScale = null;
      }
      this.#scheduleFrame();
    };
    // Schedule FIRST; only enter the frozen state once scheduling succeeds. If
    // scheduling ever throws, the engine must not be left frozen with no timer
    // to release it (that was the permanent-silence bug) -- leave state
    // consistent and let frames proceed unfrozen.
    try {
      this.#settleHandle = this.#setTimer(run, SETTLE_DELAY_MS);
    } catch {
      this.#settleHandle = null;
      this.#resettling = false;
      return;
    }
    this.#resettling = true;
  }

  #frame = (): void => {
    if (this.#disposed) return;

    // Rule 4b: no virtual keyboard exists on non-touch devices. Reporting zeros
    // here prevents false positives when a desktop user shrinks the window with
    // an input focused. Unreadable maxTouchPoints -> assume touch-capable.
    if (!this.#isTouchCapable()) {
      this.#clearBaselines();
      this.#report(ZERO_RECT, 0);
      return;
    }

    const active = deepActiveElement(this.#doc);
    const editable = isEditableElement(active);
    const vv = this.#win.visualViewport;

    if (!editable || !vv) {
      // No editable focused (or no viewport to measure) -> keyboard is not ours to report.
      this.#clearBaselines();
      this.#report(ZERO_RECT, 0);
      return;
    }

    // Rule 3: pinch-zoom guard. Guard on scale CHANGE from the captured baseline,
    // not absolute value: iOS Safari page zoom (aA menu) parks vv.scale at a
    // constant non-1 value permanently, so freezing on `scale != 1` would disable
    // the engine for those users. A stable non-1 scale measures fine because the
    // baseline and current readings share the same CSS-pixel space. On a genuine
    // pinch, freeze (keep last rect) and schedule a re-baseline so we recapture at
    // the new stable scale once the pinch stops moving.
    if (this.#baselineScale !== null && Math.abs(vv.scale - this.#baselineScale) > PINCH_EPSILON) {
      this.#requestRebaseline("scale");
      return;
    }

    // Rule 4: while a resize/orientation settle is pending, freeze.
    if (this.#resettling) {
      return;
    }

    // Rule 2/3: capture both baselines (and the scale) on the unfocused ->
    // focused transition, then hold them while focus moves between editables
    // (keyboard stays open).
    if (this.#baselineHeight === null) {
      this.#baselineBottom = vv.height + vv.offsetTop;
      this.#baselineHeight = vv.height;
      this.#baselineScale = vv.scale;
    }

    // Rule 2 dual metrics:
    //  - trueHeight: physical keyboard size, independent of any browser scroll
    //    compensation. Drives boundingRect + geometrychange + hide detection.
    //  - remainder: how much of the layout bottom the browser did NOT already
    //    reveal by scrolling the visual viewport. Drives the CSS props only, so
    //    bottom-fixed content lifts by only what is still needed.
    const trueHeight = Math.max(0, Math.round((this.#baselineHeight ?? vv.height) - vv.height));
    const remainder = Math.max(
      0,
      Math.round((this.#baselineBottom ?? vv.height + vv.offsetTop) - vv.height - vv.offsetTop),
    );

    // Rule 5: keyboard dismissed while still focused -> trueHeight ~0 -> report
    // zeros (rect and remainder), but keep the baselines (still focused).
    if (trueHeight < HIDE_THRESHOLD_PX) {
      this.#report(ZERO_RECT, 0);
      return;
    }

    // boundingRect per spec: {x:0, y: innerHeight - h, width: innerWidth, height: h}.
    // x/y are documented approximations; height is the load-bearing value.
    const rect: RectValue = {
      x: 0,
      y: this.#win.innerHeight - trueHeight,
      width: this.#win.innerWidth,
      height: trueHeight,
    };
    this.#report(rect, remainder);
  };

  #clearBaselines(): void {
    this.#baselineBottom = null;
    this.#baselineHeight = null;
    this.#baselineScale = null;
  }

  #isTouchCapable(): boolean {
    const nav = this.#win.navigator;
    if (nav && typeof nav.maxTouchPoints === "number") {
      return nav.maxTouchPoints > 0;
    }
    return true;
  }

  // Rule 2: fire when EITHER metric changed. The rect can hold steady while the
  // remainder shifts (e.g. iOS scroll-compensates a keyboard that is already
  // up), so rect equality alone no longer gates a report.
  #report(rect: RectValue, remainder: number): void {
    if (rectsEqual(rect, this.#lastRect) && remainder === this.#lastRemainder) return;
    this.#lastRect = rect;
    this.#lastRemainder = remainder;
    this.#onRectChange(rect, remainder);
  }

  #scheduleFrame(): void {
    if (this.#frameScheduled || this.#disposed) return;
    this.#frameScheduled = true;
    const run = () => {
      this.#frameScheduled = false;
      this.#frameHandle = null;
      this.#frame();
    };
    if (typeof this.#win.requestAnimationFrame === "function") {
      this.#frameUsesRaf = true;
      this.#frameHandle = this.#win.requestAnimationFrame(run);
    } else {
      this.#frameUsesRaf = false;
      this.#frameHandle = this.#setTimer(run, 0);
    }
  }

  #cancelFrame(): void {
    if (!this.#frameScheduled || this.#frameHandle == null) return;
    this.#frameScheduled = false;
    if (this.#frameUsesRaf && typeof this.#win.cancelAnimationFrame === "function") {
      this.#win.cancelAnimationFrame(this.#frameHandle as number);
    } else {
      this.#clearTimer(this.#frameHandle);
    }
    this.#frameHandle = null;
  }

  #cancelSettle(): void {
    if (this.#settleHandle == null) return;
    this.#clearTimer(this.#settleHandle);
    this.#settleHandle = null;
  }

  // Deferred timers MUST be invoked as methods on their owner. In real browsers,
  // `window.setTimeout`/`clearTimeout` throw "Illegal invocation" when called
  // detached from the Window receiver (e.g. `const f = win.setTimeout; f(cb)`),
  // which previously left the engine permanently frozen. Method-call syntax
  // (`this.#win.setTimeout(...)`) preserves the receiver; the global fallback is
  // only reached when the injected win has no timer of its own.
  #setTimer(cb: () => void, ms: number): unknown {
    if (typeof this.#win.setTimeout === "function") {
      return this.#win.setTimeout(cb, ms);
    }
    return setTimeout(cb, ms);
  }

  #clearTimer(handle: unknown): void {
    if (handle == null) return;
    if (typeof this.#win.clearTimeout === "function") {
      this.#win.clearTimeout(handle);
    } else {
      clearTimeout(handle as never);
    }
  }

  #addListener(
    target: WindowLike | DocumentLike | VisualViewportLike | null | undefined,
    type: string,
    handler: (ev?: unknown) => void,
  ): void {
    if (target && typeof target.addEventListener === "function") {
      target.addEventListener(type, handler, { passive: true });
    }
  }

  #removeListener(
    target: WindowLike | DocumentLike | VisualViewportLike | null | undefined,
    type: string,
    handler: (ev?: unknown) => void,
  ): void {
    if (target && typeof target.removeEventListener === "function") {
      target.removeEventListener(type, handler);
    }
  }
}
