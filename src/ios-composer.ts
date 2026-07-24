/**
 * Vanilla iOS composer Recipe. Wires pre-lift, preventScroll focus, gated bar
 * controls, and scoped scroll lock. Reads keyboard height only from a
 * VirtualKeyboard-like source (default `navigator.virtualKeyboard`) — never
 * re-measures visualViewport.
 *
 * Side-effect-free: does not install the polyfill. Callers use `/auto` or
 * `createVirtualKeyboard` first. SSR-safe to import; `attachIosComposer` only
 * touches DOM APIs when invoked with real elements.
 */

export type VirtualKeyboardSource = {
  readonly boundingRect: { readonly height: number };
  addEventListener(type: string, listener: EventListenerOrEventListenerObject): void;
  removeEventListener(type: string, listener: EventListenerOrEventListenerObject): void;
};

export type AttachIosComposerOptions = {
  /** Fixed/sticky bar root. */
  composer: HTMLElement;
  /** Texty controls to pre-lift + focus({preventScroll}). Default: text fields inside composer. */
  fields?: Iterable<HTMLElement>;
  /** Non-field controls that get gated pre-lift (send, attach, …). */
  controls?: Iterable<HTMLElement>;
  /** Height + geometrychange source. Default: `navigator.virtualKeyboard`. */
  virtualKeyboard?: VirtualKeyboardSource;
  /** Scroll-lock target while keyboard height > 0. Default: `window`. */
  scrollTarget?: Window | Element;
  /** Test seam for height. Default: `virtualKeyboard.boundingRect.height`. */
  getHeight?: () => number;
};

export type IosComposerHandle = {
  dispose(): void;
};

type Focusable = HTMLElement & {
  focus(options?: FocusOptions): void;
};

function resolveVirtualKeyboard(
  explicit: VirtualKeyboardSource | undefined,
): VirtualKeyboardSource | undefined {
  if (explicit) return explicit;
  if (typeof navigator !== "undefined") {
    const nav = navigator as Navigator & { virtualKeyboard?: VirtualKeyboardSource };
    if (nav.virtualKeyboard) return nav.virtualKeyboard;
  }
  return undefined;
}

function resolveScrollTarget(explicit: Window | Element | undefined): Window | Element | undefined {
  if (explicit) return explicit;
  if (typeof window !== "undefined") return window;
  return undefined;
}

function isTextyField(el: Element): el is HTMLElement {
  if (!(el instanceof HTMLElement)) return false;
  const tag = el.tagName;
  if (tag === "TEXTAREA") return true;
  if (tag === "INPUT") {
    const type = ((el as HTMLInputElement).type || "text").toLowerCase();
    // Match typical chat/composer text entry; exclude buttons/checkboxes/etc.
    return (
      type === "text" ||
      type === "search" ||
      type === "email" ||
      type === "tel" ||
      type === "url" ||
      type === "password" ||
      type === "number" ||
      type === ""
    );
  }
  return el.isContentEditable;
}

function defaultFields(composer: HTMLElement): HTMLElement[] {
  const out: HTMLElement[] = [];
  const nodes = composer.querySelectorAll("input, textarea, [contenteditable]");
  for (const node of nodes) {
    if (isTextyField(node)) out.push(node);
  }
  return out;
}

function readHeight(
  vk: VirtualKeyboardSource | undefined,
  getHeight: (() => number) | undefined,
): number {
  if (getHeight) {
    const h = getHeight();
    return Number.isFinite(h) ? Math.max(0, h) : 0;
  }
  if (!vk) return 0;
  const h = vk.boundingRect.height;
  return Number.isFinite(h) ? Math.max(0, h) : 0;
}

function applyPreLift(composer: HTMLElement, height: number): void {
  // Sync write before focus so Safari's pre-focus visibility check sees the
  // lifted bar. Inline `bottom` matches sticky/fixed composers that also use
  // `env(keyboard-inset-height)` / `--keyboard-inset-height` (same axis — not
  // additive like transform + bottom would be).
  if (height > 0) {
    composer.style.bottom = `${height}px`;
  } else {
    composer.style.bottom = "";
  }
}

function scrollToTop(target: Window | Element): void {
  if (typeof Window !== "undefined" && target instanceof Window) {
    target.scrollTo(0, 0);
    return;
  }
  // Element path (also covers Window-like fakes without instanceof Window).
  const el = target as Element & { scrollTo?: (x: number, y: number) => void; scrollTop?: number };
  if (typeof el.scrollTo === "function") {
    el.scrollTo(0, 0);
  } else if (typeof el.scrollTop === "number") {
    el.scrollTop = 0;
  } else if (typeof (target as Window).scrollTo === "function") {
    (target as Window).scrollTo(0, 0);
  }
}

/**
 * Attach iOS Safari chat-composer focus/pre-lift/scroll-lock behavior.
 * Does not install the VirtualKeyboard polyfill and does not mutate html/body CSS.
 */
export function attachIosComposer(options: AttachIosComposerOptions): IosComposerHandle {
  const { composer } = options;
  const vk = resolveVirtualKeyboard(options.virtualKeyboard);
  const scrollTarget = resolveScrollTarget(options.scrollTarget);
  const getHeight = options.getHeight;

  const fields = [...(options.fields ?? defaultFields(composer))];
  const controls = [...(options.controls ?? [])];

  let currentHeight = readHeight(vk, getHeight);
  /** Last non-zero height for pre-lift when re-opening after close. */
  let lastKnownHeight = currentHeight > 0 ? currentHeight : 0;

  const syncFromSource = (): void => {
    currentHeight = readHeight(vk, getHeight);
    if (currentHeight > 0) lastKnownHeight = currentHeight;
    // Keep visual lift in sync with live height (clear when keyboard hides).
    applyPreLift(composer, currentHeight);
  };

  const onGeometryChange = (): void => {
    syncFromSource();
  };

  const onFieldMouseDown = (event: Event): void => {
    const target = event.currentTarget as Focusable;
    // Pre-lift with last known height so Safari sees the bar already raised.
    applyPreLift(composer, lastKnownHeight > 0 ? lastKnownHeight : currentHeight);
    if (typeof target.focus === "function") {
      target.focus({ preventScroll: true });
    }
    event.preventDefault();
  };

  const onControlMouseDown = (): void => {
    // Gated: only when keyboard is already open (avoids phantom lift when closed).
    if (currentHeight > 0) {
      applyPreLift(composer, currentHeight);
    }
  };

  const onScroll = (): void => {
    if (currentHeight > 0 && scrollTarget) {
      scrollToTop(scrollTarget);
    }
  };

  for (const field of fields) {
    field.addEventListener("mousedown", onFieldMouseDown);
  }
  for (const control of controls) {
    control.addEventListener("mousedown", onControlMouseDown);
  }
  if (vk) {
    vk.addEventListener("geometrychange", onGeometryChange);
  }
  if (scrollTarget) {
    scrollTarget.addEventListener("scroll", onScroll);
  }

  // Seed visual state from current VK height (e.g. attach while keyboard open).
  syncFromSource();

  return {
    dispose(): void {
      for (const field of fields) {
        field.removeEventListener("mousedown", onFieldMouseDown);
      }
      for (const control of controls) {
        control.removeEventListener("mousedown", onControlMouseDown);
      }
      if (vk) {
        vk.removeEventListener("geometrychange", onGeometryChange);
      }
      if (scrollTarget) {
        scrollTarget.removeEventListener("scroll", onScroll);
      }
      composer.style.bottom = "";
    },
  };
}
