/**
 * Tiny hand-rolled DOM/viewport fakes for driving the geometry engine
 * deterministically. The engine's WindowLike/DocumentLike/VisualViewportLike
 * surfaces are intentionally minimal, so we implement only what it reads.
 *
 * Timing is manual: `requestAnimationFrame` and `setTimeout` queue callbacks
 * instead of firing. Call `flushRaf()` to run coalesced frames,
 * `advanceTimers(ms)` to run due timers (e.g. the 80ms height-stability filter),
 * and `flushTimers()` to run every pending timer (e.g. the 300ms re-baseline).
 * This lets tests reproduce the "many events, one frame" coalescing the engine
 * relies on.
 */

import type {
  DocumentLike,
  ElementLike,
  VisualViewportLike,
  WindowLike,
} from "../src/geometry.ts";
import type { StyleTarget } from "../src/css-properties.ts";

type Listener = (ev?: unknown) => void;

class Emitter {
  private listeners = new Map<string, Set<Listener>>();

  addEventListener(type: string, cb: Listener, _options?: unknown): void {
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(cb);
  }

  removeEventListener(type: string, cb: Listener, _options?: unknown): void {
    this.listeners.get(type)?.delete(cb);
  }

  emit(type: string): void {
    const set = this.listeners.get(type);
    if (!set) return;
    for (const cb of [...set]) cb();
  }

  listenerCount(type: string): number {
    return this.listeners.get(type)?.size ?? 0;
  }

  totalListeners(): number {
    let n = 0;
    for (const set of this.listeners.values()) n += set.size;
    return n;
  }
}

export class FakeVisualViewport extends Emitter implements VisualViewportLike {
  width: number;
  height: number;
  offsetTop = 0;
  offsetLeft = 0;
  scale = 1;

  constructor(init: { width: number; height: number }) {
    super();
    this.width = init.width;
    this.height = init.height;
  }
}

export class FakeStyle {
  props = new Map<string, string>();
  setProperty(property: string, value: string): void {
    this.props.set(property, value);
  }
  get(property: string): string | undefined {
    return this.props.get(property);
  }
}

export class FakeDocument extends Emitter implements DocumentLike, StyleTarget {
  activeElement: ElementLike | null = null;
  documentElement: { style: FakeStyle } = { style: new FakeStyle() };
}

interface Timer {
  id: number;
  cb: () => void;
  /** Absolute virtual time when this timer should fire. */
  fireAt: number;
}

export class FakeWindow extends Emitter implements WindowLike {
  innerWidth: number;
  innerHeight: number;
  visualViewport: VisualViewportLike | null;
  navigator?: { maxTouchPoints?: number };

  /** When false, `requestAnimationFrame` is left undefined so the engine falls
   *  back to `setTimeout` for frame scheduling. */
  private readonly useRaf: boolean;
  private rafQueue: Array<() => void> = [];
  private timers: Timer[] = [];
  private nextTimerId = 1;
  /** Virtual clock for `advanceTimers` / delayed setTimeout. */
  private now = 0;

  // These four are installed in the constructor as receiver-checked functions
  // (see below). setTimeout/clearTimeout are always present; the rAF pair is
  // installed only when `useRaf` is true.
  setTimeout!: (cb: () => void, ms?: number) => number;
  clearTimeout!: (handle: unknown) => void;
  requestAnimationFrame?: (cb: () => void) => number;
  cancelAnimationFrame?: (handle: number) => void;

  constructor(init: {
    innerWidth: number;
    innerHeight: number;
    visualViewport: VisualViewportLike | null;
    navigator?: { maxTouchPoints?: number };
    useRaf?: boolean;
  }) {
    super();
    this.innerWidth = init.innerWidth;
    this.innerHeight = init.innerHeight;
    this.visualViewport = init.visualViewport;
    this.navigator = init.navigator;
    this.useRaf = init.useRaf ?? true;

    // Faithful WebIDL receiver semantics: on a real Window, setTimeout /
    // clearTimeout / requestAnimationFrame / cancelAnimationFrame throw
    // TypeError "Illegal invocation" when called detached from the Window
    // receiver (e.g. `const f = win.setTimeout; f(cb)`). Mirroring that here
    // makes the whole suite regression-proof against detached-call bugs like the
    // one that left the engine permanently frozen after the first blur. Callers
    // that use method syntax (`win.setTimeout(...)`) pass; detached callers throw.
    const self = this;
    const illegal = (): never => {
      throw new TypeError("Illegal invocation");
    };

    this.setTimeout = function (this: unknown, cb: () => void, ms?: number): number {
      if (this !== self) illegal();
      const id = self.nextTimerId++;
      self.timers.push({ id, cb, fireAt: self.now + (ms ?? 0) });
      return id;
    };
    this.clearTimeout = function (this: unknown, handle: unknown): void {
      if (this !== self) illegal();
      self.timers = self.timers.filter((t) => t.id !== handle);
    };

    if (this.useRaf) {
      this.requestAnimationFrame = function (this: unknown, cb: () => void): number {
        if (this !== self) illegal();
        self.rafQueue.push(cb);
        return self.rafQueue.length;
      };
      this.cancelAnimationFrame = function (this: unknown, _handle: number): void {
        if (this !== self) illegal();
        // No-op: the engine guards flushed frames with its own `disposed` flag.
      };
    }
  }

  /** Run every queued animation frame (and, when rAF is disabled, timer-backed
   *  frames that are already due). */
  flushRaf(): void {
    if (this.useRaf) {
      const q = this.rafQueue;
      this.rafQueue = [];
      for (const cb of q) cb();
      return;
    }
    // rAF disabled: frames were scheduled via setTimeout(cb, 0).
    const due = this.timers.filter((t) => t.fireAt <= this.now);
    const dueIds = new Set(due.map((t) => t.id));
    this.timers = this.timers.filter((t) => !dueIds.has(t.id));
    for (const t of due) t.cb();
  }

  /**
   * Advance the virtual clock by `ms` and run every timer whose fire time is
   * now due (in fire-time order). Timers scheduled during a callback use the
   * advanced clock as their origin.
   */
  advanceTimers(ms: number): void {
    const target = this.now + ms;
    while (this.timers.length > 0) {
      let next: Timer | null = null;
      for (const t of this.timers) {
        if (t.fireAt > target) continue;
        if (!next || t.fireAt < next.fireAt || (t.fireAt === next.fireAt && t.id < next.id)) {
          next = t;
        }
      }
      if (!next) break;
      this.now = next.fireAt;
      this.timers = this.timers.filter((t) => t.id !== next!.id);
      next.cb();
    }
    this.now = target;
  }

  /** Run every pending timer (e.g. the 300ms re-baseline settle). */
  flushTimers(): void {
    while (this.timers.length > 0) {
      let next: Timer | null = null;
      for (const t of this.timers) {
        if (!next || t.fireAt < next.fireAt || (t.fireAt === next.fireAt && t.id < next.id)) {
          next = t;
        }
      }
      if (!next) break;
      this.now = next.fireAt;
      this.timers = this.timers.filter((t) => t.id !== next!.id);
      next.cb();
    }
  }

  pendingTimers(): number {
    return this.timers.length;
  }
}

/** An editable `<input type="text">`-like element. */
export function input(type = "text"): ElementLike {
  return { tagName: "INPUT", type };
}

/** A `<textarea>`-like element. */
export function textarea(): ElementLike {
  return { tagName: "TEXTAREA" };
}

/** A contenteditable-like element. */
export function contenteditable(): ElementLike {
  return { tagName: "DIV", isContentEditable: true };
}
