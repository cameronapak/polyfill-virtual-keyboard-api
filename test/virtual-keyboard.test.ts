/**
 * VirtualKeyboardPolyfill + createVirtualKeyboard tests. Covers SPEC scenarios
 * 6 (hide/show) and 8 (native passthrough) plus post-spec requirements:
 * ongeometrychange add/remove semantics, dispose() listener teardown, and
 * cssProperties wiring through the geometry engine.
 */

import { test, expect, describe } from "bun:test";
import { createVirtualKeyboard, VirtualKeyboardPolyfill } from "../src/index.ts";
import {
  FakeWindow,
  FakeDocument,
  FakeVisualViewport,
  input,
  type FakeStyle,
} from "./fakes.ts";

interface VKHarness {
  win: FakeWindow;
  doc: FakeDocument;
  vv: FakeVisualViewport;
  vk: VirtualKeyboardPolyfill;
  style: FakeStyle;
  openKeyboard(height?: number): void;
  closeKeyboard(): void;
}

function makeVK(opts: { cssProperties?: boolean } = {}): VKHarness {
  const vv = new FakeVisualViewport({ width: 390, height: 844 });
  const win = new FakeWindow({
    innerWidth: 390,
    innerHeight: 844,
    visualViewport: vv,
    navigator: { maxTouchPoints: 5 },
  });
  const doc = new FakeDocument();
  const vk = new VirtualKeyboardPolyfill({
    window: win,
    document: doc,
    cssProperties: opts.cssProperties ?? false,
  });
  win.flushRaf(); // seed frame
  return {
    win,
    doc,
    vv,
    vk,
    style: doc.documentElement.style,
    openKeyboard(height = 300) {
      doc.activeElement = input();
      doc.emit("focusin");
      win.flushRaf();
      vv.height = 844 - height;
      vv.emit("resize");
      win.flushRaf();
    },
    closeKeyboard() {
      doc.activeElement = null;
      doc.emit("focusout");
      win.flushRaf();
    },
  };
}

describe("createVirtualKeyboard passthrough (scenario 8)", () => {
  test("returns native navigator.virtualKeyboard when present", () => {
    const native = { boundingRect: {}, overlaysContent: true, __native: true };
    const result = createVirtualKeyboard({
      navigator: { virtualKeyboard: native } as never,
    });
    expect(result).toBe(native as never);
  });

  test("returns a polyfill instance when native is absent", () => {
    const result = createVirtualKeyboard({ navigator: {} as never });
    expect(result).toBeInstanceOf(VirtualKeyboardPolyfill);
    expect((result as VirtualKeyboardPolyfill).isPolyfill).toBe(true);
  });

  test("returns a polyfill when navigator.virtualKeyboard is falsy", () => {
    const result = createVirtualKeyboard({
      navigator: { virtualKeyboard: undefined } as never,
    });
    expect(result).toBeInstanceOf(VirtualKeyboardPolyfill);
  });
});

describe("boundingRect + geometrychange", () => {
  test("boundingRect updates and geometrychange fires on keyboard open", () => {
    const h = makeVK();
    let count = 0;
    h.vk.addEventListener("geometrychange", () => count++);
    h.openKeyboard(300);
    expect(count).toBe(1);
    expect(h.vk.boundingRect.height).toBe(300);
    expect(h.vk.boundingRect.width).toBe(390);
    expect(h.vk.boundingRect.y).toBe(844 - 300);
  });

  test("boundingRect returns to zeros with an event on close", () => {
    const h = makeVK();
    let count = 0;
    h.vk.addEventListener("geometrychange", () => count++);
    h.openKeyboard(300);
    h.closeKeyboard();
    expect(count).toBe(2); // open + close
    expect(h.vk.boundingRect.height).toBe(0);
    expect(h.vk.boundingRect.width).toBe(0);
  });
});

describe("ongeometrychange property (add/remove semantics)", () => {
  test("assigned handler is invoked", () => {
    const h = makeVK();
    let calls = 0;
    h.vk.ongeometrychange = () => calls++;
    h.openKeyboard(300);
    expect(calls).toBe(1);
    expect(h.vk.ongeometrychange).toBeInstanceOf(Function);
  });

  test("reassigning replaces the previous handler (old one removed)", () => {
    const h = makeVK();
    let a = 0;
    let b = 0;
    h.vk.ongeometrychange = () => a++;
    h.vk.ongeometrychange = () => b++;
    h.openKeyboard(300);
    expect(a).toBe(0); // first handler removed
    expect(b).toBe(1);
  });

  test("setting null removes the handler", () => {
    const h = makeVK();
    let calls = 0;
    h.vk.ongeometrychange = () => calls++;
    h.vk.ongeometrychange = null;
    expect(h.vk.ongeometrychange).toBeNull();
    h.openKeyboard(300);
    expect(calls).toBe(0);
  });

  test("does not double-fire alongside addEventListener", () => {
    const h = makeVK();
    let onProp = 0;
    let onListener = 0;
    h.vk.ongeometrychange = () => onProp++;
    h.vk.addEventListener("geometrychange", () => onListener++);
    h.openKeyboard(300);
    expect(onProp).toBe(1);
    expect(onListener).toBe(1);
  });
});

describe("cssProperties wiring", () => {
  test("writes --keyboard-inset-* on rect change when enabled", () => {
    const h = makeVK({ cssProperties: true });
    h.openKeyboard(300);
    expect(h.style.get("--keyboard-inset-height")).toBe("300px");
    expect(h.style.get("--keyboard-inset-top")).toBe("544px");
    expect(h.style.get("--keyboard-inset-bottom")).toBe("0px");
  });

  test("does not write custom properties when disabled (default)", () => {
    const h = makeVK({ cssProperties: false });
    h.openKeyboard(300);
    expect(h.style.get("--keyboard-inset-height")).toBeUndefined();
  });
});

describe("show()/hide() (scenario 6)", () => {
  test("hide() blurs the focused editable", () => {
    const vv = new FakeVisualViewport({ width: 390, height: 844 });
    const win = new FakeWindow({
      innerWidth: 390,
      innerHeight: 844,
      visualViewport: vv,
      navigator: { maxTouchPoints: 5 },
    });
    const doc = new FakeDocument();
    let blurred = false;
    doc.activeElement = { tagName: "INPUT", type: "text", blur: () => (blurred = true) };
    const vk = new VirtualKeyboardPolyfill({ window: win, document: doc });
    win.flushRaf();
    expect(vk.hide()).toBeUndefined();
    expect(blurred).toBe(true);
  });

  test("show() refocuses the active editable and never throws", () => {
    const vv = new FakeVisualViewport({ width: 390, height: 844 });
    const win = new FakeWindow({
      innerWidth: 390,
      innerHeight: 844,
      visualViewport: vv,
      navigator: { maxTouchPoints: 5 },
    });
    const doc = new FakeDocument();
    let focused = false;
    doc.activeElement = { tagName: "INPUT", type: "text", focus: () => (focused = true) };
    const vk = new VirtualKeyboardPolyfill({ window: win, document: doc });
    win.flushRaf();
    expect(() => vk.show()).not.toThrow();
    expect(vk.show()).toBeUndefined();
    expect(focused).toBe(true);
  });

  test("show()/hide() are no-ops when nothing editable is focused", () => {
    const h = makeVK();
    expect(() => h.vk.show()).not.toThrow();
    expect(() => h.vk.hide()).not.toThrow();
  });
});

describe("overlaysContent stored flag", () => {
  test("defaults to false, stores assignments", () => {
    const h = makeVK();
    expect(h.vk.overlaysContent).toBe(false);
    h.vk.overlaysContent = true;
    expect(h.vk.overlaysContent).toBe(true);
    h.vk.overlaysContent = false;
    expect(h.vk.overlaysContent).toBe(false);
  });
});

describe("dispose() removes listeners", () => {
  test("subsequent viewport events do not fire geometrychange", () => {
    const h = makeVK();
    let count = 0;
    h.vk.addEventListener("geometrychange", () => count++);
    h.openKeyboard(300);
    expect(count).toBe(1);

    h.vk.dispose();
    // Engine listeners are gone; further vv changes are ignored.
    h.vv.height = 400;
    h.vv.emit("resize");
    h.win.flushRaf();
    expect(count).toBe(1);
    expect(h.vv.totalListeners()).toBe(0);
    expect(h.win.totalListeners()).toBe(0);
    expect(h.doc.totalListeners()).toBe(0);
  });

  test("dispose is safe to call and clears boundingRect", () => {
    const h = makeVK();
    h.openKeyboard(300);
    h.vk.dispose();
    expect(h.vk.boundingRect.height).toBe(0);
  });
});

describe("SSR safety", () => {
  test("constructs without window/document and does not throw", () => {
    expect(() => new VirtualKeyboardPolyfill()).not.toThrow();
    const vk = new VirtualKeyboardPolyfill({});
    expect(vk.isPolyfill).toBe(true);
    expect(vk.boundingRect.height).toBe(0);
    expect(() => vk.show()).not.toThrow();
    expect(() => vk.hide()).not.toThrow();
    expect(() => vk.dispose()).not.toThrow();
  });
});
