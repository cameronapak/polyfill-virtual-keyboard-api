/**
 * Geometry engine tests. The engine is dependency-injected, so we drive it with
 * hand-rolled window/document/visualViewport fakes (see ./fakes.ts) and manual
 * frame/timer flushing. Covers SPEC "Tests" scenarios 1-5 plus the post-spec
 * behaviors (height-only vs width-changing resize, touch gate, shadow DOM,
 * editability rules, rAF->setTimeout fallback).
 */

import { test, expect, describe } from "bun:test";
import {
  GeometryEngine,
  deepActiveElement,
  isEditableElement,
  type ElementLike,
  type RectValue,
} from "../src/geometry.ts";
import {
  FakeWindow,
  FakeDocument,
  FakeVisualViewport,
  input,
  textarea,
  contenteditable,
} from "./fakes.ts";

interface Harness {
  win: FakeWindow;
  doc: FakeDocument;
  vv: FakeVisualViewport;
  rects: RectValue[];
  engine: GeometryEngine;
  /** flush coalesced frames */
  frame(): void;
  last(): RectValue;
}

function setup(opts: {
  innerWidth?: number;
  innerHeight?: number;
  vvWidth?: number;
  vvHeight?: number;
  maxTouchPoints?: number | undefined;
  hasNavigator?: boolean;
  useRaf?: boolean;
} = {}): Harness {
  const innerWidth = opts.innerWidth ?? 390;
  const innerHeight = opts.innerHeight ?? 844;
  const vv = new FakeVisualViewport({
    width: opts.vvWidth ?? innerWidth,
    height: opts.vvHeight ?? innerHeight,
  });
  const navigator =
    opts.hasNavigator === false
      ? undefined
      : { maxTouchPoints: opts.maxTouchPoints ?? 5 };
  const win = new FakeWindow({
    innerWidth,
    innerHeight,
    visualViewport: vv,
    navigator,
    useRaf: opts.useRaf,
  });
  const doc = new FakeDocument();
  const rects: RectValue[] = [];
  const engine = new GeometryEngine({
    win,
    doc,
    onRectChange: (r) => rects.push({ ...r }),
  });
  engine.start();
  win.flushRaf(); // consume the seed frame
  return {
    win,
    doc,
    vv,
    rects,
    engine,
    frame: () => win.flushRaf(),
    last: () => rects[rects.length - 1] ?? { x: 0, y: 0, width: 0, height: 0 },
  };
}

/** Focus an editable while the viewport is still full-height (captures baseline). */
function focus(h: Harness, el: ElementLike): void {
  h.doc.activeElement = el;
  h.doc.emit("focusin");
  h.frame();
}

/** Simulate the keyboard shrinking the visual viewport to `height`. */
function shrinkViewport(h: Harness, height: number): void {
  h.vv.height = height;
  h.vv.emit("resize");
  h.frame();
}

describe("scenario 1: classic iOS Safari (innerHeight constant, vv shrinks)", () => {
  test("reports occlusion rect and fires onRectChange", () => {
    const h = setup({ innerWidth: 390, innerHeight: 844 });
    focus(h, input());
    // At focus the viewport is full; occlusion is 0 -> still zeros.
    expect(h.last().height).toBe(0);

    shrinkViewport(h, 544); // keyboard ~300px
    const r = h.last();
    expect(r.height).toBe(300);
    expect(r.width).toBe(390);
    expect(r.x).toBe(0);
    expect(r.y).toBe(844 - 300); // innerHeight - height
    // A single change event for the shrink.
    expect(h.rects.filter((x) => x.height === 300).length).toBe(1);
  });
});

describe("scenario 2: WKWebView both-shrink (innerHeight AND vv.height shrink)", () => {
  test("baseline capture keeps occlusion correct", () => {
    const h = setup({ innerWidth: 390, innerHeight: 844 });
    focus(h, textarea()); // baseline = 844

    // Keyboard shrinks BOTH innerHeight and vv.height together.
    h.win.innerHeight = 544;
    h.vv.height = 544;
    h.win.emit("resize"); // height-only window resize
    h.vv.emit("resize");
    h.frame();

    const r = h.last();
    expect(r.height).toBe(300); // baseline 844 - vv 544
    expect(r.y).toBe(544 - 300); // innerHeight(now 544) - height
  });
});

describe("scenario 3: pinch-zoom guard", () => {
  test("scale != 1 freezes updates", () => {
    const h = setup();
    focus(h, input());
    shrinkViewport(h, 544);
    expect(h.last().height).toBe(300);

    // Pinch to 2x, then shrink further: should be frozen (no new rect).
    const before = h.rects.length;
    h.vv.scale = 2;
    shrinkViewport(h, 400);
    expect(h.rects.length).toBe(before); // frozen
    expect(h.last().height).toBe(300); // last rect retained

    // Release zoom -> resumes.
    h.vv.scale = 1;
    h.vv.emit("resize");
    h.frame();
    expect(h.last().height).toBe(844 - 400);
  });
});

describe("scenario 4: blur -> zeros + event", () => {
  test("focusout with no editable zeros the rect", () => {
    const h = setup();
    focus(h, input());
    shrinkViewport(h, 544);
    expect(h.last().height).toBe(300);

    h.doc.activeElement = null;
    h.doc.emit("focusout");
    h.frame();
    const r = h.last();
    expect(r).toEqual({ x: 0, y: 0, width: 0, height: 0 });
  });
});

describe("scenario 5: focus moves editable -> editable (no flicker)", () => {
  test("focusout+focusin coalesce into one frame, baseline retained", () => {
    const h = setup();
    const a = input();
    const b = textarea();
    focus(h, a);
    shrinkViewport(h, 544);
    expect(h.last().height).toBe(300);

    const changesBefore = h.rects.length;
    // Blur A and focus B before the next frame runs (real rAF coalescing).
    h.doc.activeElement = null;
    h.doc.emit("focusout");
    h.doc.activeElement = b;
    h.doc.emit("focusin");
    h.frame(); // single coalesced frame sees B editable

    // No flicker to zeros: rect unchanged, so no new change emitted.
    expect(h.rects.length).toBe(changesBefore);
    expect(h.last().height).toBe(300);
  });
});

describe("post-spec: height-only window resize does NOT re-baseline", () => {
  test("occlusion still reported after both-shrink + window/vv resize", () => {
    const h = setup({ innerWidth: 390, innerHeight: 844 });
    focus(h, input()); // baseline 844

    // WKWebView: keyboard shrinks innerHeight AND vv.height, fires both events.
    h.win.innerHeight = 500;
    h.vv.height = 500;
    h.win.emit("resize"); // width unchanged -> must NOT re-baseline
    h.vv.emit("resize");
    h.frame();

    expect(h.last().height).toBe(344); // 844 - 500, baseline preserved
    // No settle timer was scheduled (no re-baseline requested).
    expect(h.win.pendingTimers()).toBe(0);
  });
});

describe("post-spec: width-changing resize DOES re-baseline after settle", () => {
  test("frozen during settle, then re-baselines against current geometry", () => {
    const h = setup({ innerWidth: 390, innerHeight: 844 });
    focus(h, input());
    shrinkViewport(h, 544);
    expect(h.last().height).toBe(300);

    // Rotate: innerWidth changes -> re-baseline requested with 300ms settle.
    h.win.innerWidth = 844;
    h.win.innerHeight = 390;
    h.vv.width = 844;
    h.vv.height = 300;
    h.win.emit("resize"); // width changed
    h.win.emit("orientationchange");
    h.frame();

    // Frozen during settle: last rect unchanged.
    expect(h.last().height).toBe(300);
    expect(h.win.pendingTimers()).toBeGreaterThan(0);

    // Settle fires -> baseline reset -> re-captured against occluded geometry,
    // so occlusion reads ~0 (documented rotation limitation).
    h.win.flushTimers();
    h.frame();
    expect(h.last()).toEqual({ x: 0, y: 0, width: 0, height: 0 });
  });
});

describe("post-spec: touch gate (Rule 4b)", () => {
  test("maxTouchPoints === 0 always reports zero rect", () => {
    const h = setup({ maxTouchPoints: 0 });
    focus(h, input());
    shrinkViewport(h, 544);
    expect(h.last()).toEqual({ x: 0, y: 0, width: 0, height: 0 });
    expect(h.rects.every((r) => r.height === 0)).toBe(true);
  });

  test("maxTouchPoints undefined is treated as touch-capable", () => {
    const h = setup({ maxTouchPoints: undefined });
    focus(h, input());
    shrinkViewport(h, 544);
    expect(h.last().height).toBe(300);
  });

  test("no navigator at all is treated as touch-capable", () => {
    const h = setup({ hasNavigator: false });
    focus(h, input());
    shrinkViewport(h, 544);
    expect(h.last().height).toBe(300);
  });
});

describe("post-spec: rAF absent falls back to setTimeout", () => {
  test("frames scheduled via setTimeout still report geometry", () => {
    const h = setup({ useRaf: false });
    focus(h, input());
    shrinkViewport(h, 544);
    expect(h.last().height).toBe(300);
  });
});

describe("deepActiveElement: shadow DOM traversal", () => {
  test("walks shadowRoot.activeElement chains to the deepest node", () => {
    const inner = input();
    const host: ElementLike = {
      tagName: "MY-COMPONENT",
      shadowRoot: { activeElement: inner },
    };
    const doc = { activeElement: host } as unknown as import("../src/geometry.ts").DocumentLike;
    expect(deepActiveElement(doc)).toBe(inner);
  });

  test("nested shadow roots", () => {
    const deepest = textarea();
    const midHost: ElementLike = {
      tagName: "INNER-HOST",
      shadowRoot: { activeElement: deepest },
    };
    const outerHost: ElementLike = {
      tagName: "OUTER-HOST",
      shadowRoot: { activeElement: midHost },
    };
    const doc = { activeElement: outerHost } as unknown as import("../src/geometry.ts").DocumentLike;
    expect(deepActiveElement(doc)).toBe(deepest);
  });

  test("engine reports occlusion when focus is inside a shadow root", () => {
    const h = setup();
    const shadowInput = input();
    const host: ElementLike = {
      tagName: "MY-COMPONENT",
      shadowRoot: { activeElement: shadowInput },
    };
    h.doc.activeElement = host;
    h.doc.emit("focusin");
    h.frame();
    shrinkViewport(h, 544);
    expect(h.last().height).toBe(300);
  });
});

describe("isEditableElement rules", () => {
  test("editable: text input, textarea, contenteditable", () => {
    expect(isEditableElement(input("text"))).toBe(true);
    expect(isEditableElement(input("email"))).toBe(true);
    expect(isEditableElement(input("search"))).toBe(true);
    expect(isEditableElement(input("url"))).toBe(true);
    expect(isEditableElement(input("tel"))).toBe(true);
    expect(isEditableElement(input("password"))).toBe(true);
    expect(isEditableElement(input("number"))).toBe(true);
    expect(isEditableElement(input())).toBe(true); // default type
    expect(isEditableElement(textarea())).toBe(true);
    expect(isEditableElement(contenteditable())).toBe(true);
  });

  test("not editable: select and non-text input types", () => {
    expect(isEditableElement({ tagName: "SELECT" })).toBe(false);
    for (const t of [
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
    ]) {
      expect(isEditableElement(input(t))).toBe(false);
    }
    expect(isEditableElement({ tagName: "DIV" })).toBe(false);
    expect(isEditableElement({ tagName: "BUTTON" })).toBe(false);
    expect(isEditableElement(null)).toBe(false);
  });
});

describe("hide threshold (Rule 5)", () => {
  test("keyboard dismissed while focused -> occlusion < 1px reports zeros", () => {
    const h = setup();
    focus(h, input());
    shrinkViewport(h, 544);
    expect(h.last().height).toBe(300);

    // User taps dismiss key: viewport grows back to ~baseline.
    shrinkViewport(h, 844);
    expect(h.last()).toEqual({ x: 0, y: 0, width: 0, height: 0 });
  });
});

describe("no viewport to measure", () => {
  test("reports zeros when visualViewport is null", () => {
    const vv = null;
    const win = new FakeWindow({
      innerWidth: 390,
      innerHeight: 844,
      visualViewport: vv,
      navigator: { maxTouchPoints: 5 },
    });
    const doc = new FakeDocument();
    const rects: RectValue[] = [];
    const engine = new GeometryEngine({ win, doc, onRectChange: (r) => rects.push({ ...r }) });
    engine.start();
    win.flushRaf();
    doc.activeElement = input();
    doc.emit("focusin");
    win.flushRaf();
    expect(rects.length).toBe(0); // never left zeros
  });
});

describe("dispose/stop tears down listeners", () => {
  test("no frames after stop", () => {
    const h = setup();
    focus(h, input());
    shrinkViewport(h, 544);
    const before = h.rects.length;
    h.engine.stop();
    // Any further events are ignored (listeners removed).
    h.vv.height = 400;
    h.vv.emit("resize");
    h.frame();
    expect(h.rects.length).toBe(before);
    expect(h.vv.totalListeners()).toBe(0);
    expect(h.win.totalListeners()).toBe(0);
    expect(h.doc.totalListeners()).toBe(0);
  });
});
