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
  /** Snapshot.remainder per commit: CSS-props remainder (Rule 2). */
  remainders: number[];
  engine: GeometryEngine;
  /** flush coalesced frames */
  frame(): void;
  last(): RectValue;
  lastRemainder(): number;
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
  const remainders: number[] = [];
  const engine = new GeometryEngine({
    win,
    doc,
    onCommit: (snapshot) => {
      rects.push({ ...snapshot.rect });
      remainders.push(snapshot.remainder);
    },
  });
  engine.start();
  win.flushRaf(); // consume the seed frame
  return {
    win,
    doc,
    vv,
    rects,
    remainders,
    engine,
    frame: () => win.flushRaf(),
    last: () => rects[rects.length - 1] ?? { x: 0, y: 0, width: 0, height: 0 },
    lastRemainder: () => remainders[remainders.length - 1] ?? 0,
  };
}

/** Height-stability filter delay (must match src/geometry.ts). */
const HEIGHT_STABILITY_MS = 80;

/** Focus an editable while the viewport is still full-height (captures baseline). */
function focus(h: Harness, el: ElementLike): void {
  h.doc.activeElement = el;
  h.doc.emit("focusin");
  h.frame();
}

/** Advance the 80ms height-stability timer and flush the commit frame. */
function settleHeight(h: Harness): void {
  h.win.advanceTimers(HEIGHT_STABILITY_MS);
  h.frame();
}

/**
 * Simulate the keyboard shrinking the visual viewport to `height`.
 * By default waits for the height-stability filter to commit.
 * Pass `{ settle: false }` to leave a pending candidate (stability tests).
 */
function shrinkViewport(h: Harness, height: number, opts: { settle?: boolean } = {}): void {
  h.vv.height = height;
  h.vv.emit("resize");
  h.frame();
  if (opts.settle !== false) settleHeight(h);
}

/**
 * Simulate the visual viewport moving to `height`/`offsetTop` together, i.e. the
 * keyboard shrinks the viewport AND the browser scrolls it (iOS scroll
 * compensation). Fires both scroll and resize, coalesced into one frame.
 * By default waits for the height-stability filter to commit.
 */
function moveViewport(
  h: Harness,
  height: number,
  offsetTop: number,
  opts: { settle?: boolean } = {},
): void {
  h.vv.height = height;
  h.vv.offsetTop = offsetTop;
  h.vv.emit("scroll");
  h.vv.emit("resize");
  h.frame();
  if (opts.settle !== false) settleHeight(h);
}

describe("scenario 1: classic iOS Safari (innerHeight constant, vv shrinks)", () => {
  test("reports occlusion rect and fires onCommit", () => {
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
    settleHeight(h);

    const r = h.last();
    expect(r.height).toBe(300); // baseline 844 - vv 544
    expect(r.y).toBe(544 - 300); // innerHeight(now 544) - height
  });
});

describe("scenario 3: pinch-zoom guard (revised - guard on scale CHANGE)", () => {
  test("genuine pinch freezes, then resumes through the settle re-baseline", () => {
    const h = setup();
    focus(h, input()); // baseline = 844, baselineScale = 1 (captured at focus)
    shrinkViewport(h, 544);
    expect(h.last().height).toBe(300);

    // A genuine pinch diverges vv.scale from the captured baseline scale.
    // The engine freezes (keeps the last rect) and schedules a re-baseline.
    const before = h.rects.length;
    h.vv.scale = 1.8;
    h.vv.emit("resize");
    h.frame();
    expect(h.rects.length).toBe(before); // frozen: no new rect
    expect(h.last().height).toBe(300); // last rect retained
    expect(h.win.pendingTimers()).toBeGreaterThan(0); // settle scheduled

    // The pinch stops at a new stable scale; the viewport now reports heights in
    // the new CSS-pixel space. The 300ms settle fires and the engine re-captures
    // BOTH baseline and baselineScale at the now-stable scale.
    h.vv.height = 700;
    h.win.flushTimers();
    h.frame();
    settleHeight(h); // focused zero still waits on height-stability
    // Re-baselined against the current (keyboard-free) geometry -> occlusion 0.
    // The pre-pinch 300px rect does NOT come back.
    expect(h.last()).toEqual({ x: 0, y: 0, width: 0, height: 0 });

    // A subsequent shrink is measured against the NEW baseline (700), at the
    // stable non-1 scale, and reports occlusion normally again.
    shrinkViewport(h, 500);
    expect(h.last().height).toBe(200); // 700 - 500, against the new baseline
  });

  test("page zoomed before focus (constant non-1 scale) reports like scale 1", () => {
    // Regression: iOS Safari page zoom (aA menu) parks vv.scale at a constant
    // non-1 value (e.g. 1.15) while vv dims equal layout dims. Because the guard
    // keys off scale CHANGE from the captured baseline (not |scale - 1|), a
    // constant zoom never freezes the engine.
    const h = setup();
    h.vv.scale = 1.15; // page zoom applied before any focus
    focus(h, input()); // baselineScale captured as 1.15

    const before = h.rects.length;
    shrinkViewport(h, 544);
    expect(h.last().height).toBe(300); // occlusion reported, not frozen
    expect(h.rects.length).toBe(before + 1); // exactly one geometrychange
    expect(h.win.pendingTimers()).toBe(0); // never entered the freeze/settle path
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
    settleHeight(h);

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
    settleHeight(h);
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
    const engine = new GeometryEngine({
      win,
      doc,
      onCommit: (snapshot) => rects.push({ ...snapshot.rect }),
    });
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

describe("post-spec: full focus/blur/refocus lifecycle (browser regression)", () => {
  // The real-browser bug: window.setTimeout/clearTimeout, called detached from
  // the Window receiver, throw "Illegal invocation". That threw inside the
  // re-baseline scheduler and left #resettling stuck true, so the engine went
  // permanently silent after the first blur. The receiver-checked fakes now
  // reproduce the WebIDL throw, and these tests assert the engine keeps working
  // across repeated focus/blur cycles.

  test("second focus cycle still reports geometry (the case that died)", () => {
    const h = setup();
    h.vv.scale = 1.15; // iOS Safari page zoom parked before any focus

    // Cycle 1: focus -> keyboard -> reported.
    focus(h, input());
    shrinkViewport(h, 544);
    expect(h.last().height).toBe(300);

    // Blur: keyboard closes, viewport restores, rect returns to zeros.
    h.vv.height = 844;
    h.doc.activeElement = null;
    h.doc.emit("focusout");
    h.frame();
    expect(h.last()).toEqual({ x: 0, y: 0, width: 0, height: 0 });

    // Cycle 2: REFOCUS + keyboard must report again, not stay silent.
    focus(h, input());
    shrinkViewport(h, 544);
    expect(h.last().height).toBe(300);

    // open -> close -> open across the two cycles.
    expect(h.rects.map((r) => r.height)).toEqual([300, 0, 300]);
    expect(h.win.pendingTimers()).toBe(0); // engine not stuck in a settle
  });

  test("spurious scale wobble RESTORES the baseline (height stays 300)", () => {
    const h = setup();
    h.vv.scale = 1.15;

    // Cycle 1 open.
    focus(h, input());
    shrinkViewport(h, 544);
    expect(h.last().height).toBe(300);

    // Transient scale wobble WHILE focused: scale diverges then returns to the
    // captured baseline value. iOS parks vv.scale transiently while the keyboard
    // animates in; this drives requestRebaseline("scale") -> settle.
    h.vv.scale = 1.5; // diverge from the captured baselineScale (1.15)
    h.vv.emit("resize");
    h.frame();
    expect(h.win.pendingTimers()).toBeGreaterThan(0); // settle scheduled
    const frozenLen = h.rects.length;

    h.vv.scale = 1.15; // wobble returns to the parked zoom (spurious)
    h.vv.emit("resize");
    h.frame();
    expect(h.rects.length).toBe(frozenLen); // still frozen until settle fires

    // Settle fires: because the scale returned to the frozen baseline and the
    // layout width did not change, the settle RESTORES the original baselines
    // rather than re-capturing an occluded mid-animation value. So the reported
    // height is STILL 300 (under the old always-recapture behavior it would drop
    // to 0 and silence the session).
    h.win.flushTimers();
    h.frame();
    expect(h.win.pendingTimers()).toBe(0);
    expect(h.last().height).toBe(300); // baseline restored, not re-captured
    expect(h.rects.every((r) => r.height > 0)).toBe(true); // never flickered to 0

    // Blur: keyboard closes, viewport restores.
    h.vv.height = 844;
    h.doc.activeElement = null;
    h.doc.emit("focusout");
    h.frame();
    expect(h.last().height).toBe(0);

    // Refocus + keyboard: still reports.
    focus(h, input());
    shrinkViewport(h, 544);
    expect(h.last().height).toBe(300);
    expect(h.win.pendingTimers()).toBe(0);
  });

  test("genuinely new stable scale re-captures a fresh baseline", () => {
    const h = setup();
    h.vv.scale = 1.15;

    // Cycle 1 open.
    focus(h, input());
    shrinkViewport(h, 544);
    expect(h.last().height).toBe(300);

    // Scale diverges to a NEW value and STAYS there (a real page-zoom change,
    // not a mid-animation wobble). Freeze + settle.
    h.vv.scale = 1.5;
    h.vv.emit("resize");
    h.frame();
    expect(h.win.pendingTimers()).toBeGreaterThan(0);

    // Settle fires while scale is still 1.5 (did not return to baseline): the
    // engine treats it as a genuine change, clears the baselines, and re-captures
    // against the current (still-occluded, 544) geometry -> trueHeight 0.
    h.win.flushTimers();
    h.frame();
    settleHeight(h);
    expect(h.win.pendingTimers()).toBe(0);
    expect(h.last().height).toBe(0); // fresh baseline against occluded geometry

    // A subsequent shrink is measured against the NEW baseline (544), at the new
    // stable scale, and reports occlusion normally again.
    shrinkViewport(h, 500);
    expect(h.last().height).toBe(44); // 544 - 500, against the fresh baseline
  });
});

describe("height stability filter (ticket 06)", () => {
  test("oscillating height during open — no geometrychange until stable 80ms", () => {
    const h = setup({ innerWidth: 390, innerHeight: 844 });
    focus(h, input());
    const before = h.rects.length;

    // Mid-animation spikes: never hold a value for a full 80ms.
    for (const height of [700, 400, 420, 410]) {
      shrinkViewport(h, height, { settle: false });
      h.win.advanceTimers(40); // < HEIGHT_STABILITY_MS — restarts pending
      expect(h.rects.length).toBe(before);
    }

    // Plateau at 410 for ≥80ms → one commit (baseline 844 - 410 = 434).
    shrinkViewport(h, 410, { settle: false });
    expect(h.rects.length).toBe(before);
    settleHeight(h);
    expect(h.rects.length).toBe(before + 1);
    expect(h.last().height).toBe(434);
  });

  test("emoji switch — second commit after new plateau", () => {
    const h = setup({ innerWidth: 390, innerHeight: 844 });
    focus(h, input());
    shrinkViewport(h, 544); // commit h1 = 300
    expect(h.last().height).toBe(300);
    const afterFirst = h.rects.length;

    // Switch toward emoji keyboard: spikes, then new plateau.
    shrinkViewport(h, 500, { settle: false });
    h.win.advanceTimers(40);
    shrinkViewport(h, 480, { settle: false });
    h.win.advanceTimers(40);
    expect(h.rects.length).toBe(afterFirst); // no commit yet

    shrinkViewport(h, 470, { settle: false }); // plateau h2 = 374
    settleHeight(h);
    expect(h.rects.length).toBe(afterFirst + 1);
    expect(h.last().height).toBe(374);
  });

  test("dismiss while focused — zeros after stable ~0", () => {
    const h = setup();
    focus(h, input());
    shrinkViewport(h, 544);
    expect(h.last().height).toBe(300);
    const afterOpen = h.rects.length;

    // Viewport returns with noise, then rests at baseline.
    shrinkViewport(h, 820, { settle: false });
    h.win.advanceTimers(40);
    shrinkViewport(h, 844, { settle: false });
    expect(h.rects.length).toBe(afterOpen);
    expect(h.last().height).toBe(300); // last committed retained

    settleHeight(h);
    expect(h.rects.length).toBe(afterOpen + 1);
    expect(h.last()).toEqual({ x: 0, y: 0, width: 0, height: 0 });
  });

  test("resettle wins over stability — cancels pending commit", () => {
    const h = setup({ innerWidth: 390, innerHeight: 844 });
    focus(h, input());
    shrinkViewport(h, 544);
    expect(h.last().height).toBe(300);
    const afterOpen = h.rects.length;

    // New candidate mid-timer (pending, not yet committed).
    shrinkViewport(h, 400, { settle: false });
    expect(h.win.pendingTimers()).toBeGreaterThan(0);
    expect(h.rects.length).toBe(afterOpen);

    // Orientation settle freezes and clears the height-stability pipeline.
    h.win.innerWidth = 844;
    h.win.innerHeight = 390;
    h.vv.width = 844;
    h.vv.height = 300;
    h.win.emit("orientationchange");
    h.frame();
    expect(h.last().height).toBe(300); // frozen on last committed
    expect(h.rects.length).toBe(afterOpen); // no commit from stale pending

    // Advancing only the old 80ms window must not commit the cancelled candidate.
    h.win.advanceTimers(HEIGHT_STABILITY_MS);
    h.frame();
    expect(h.rects.length).toBe(afterOpen);
    expect(h.last().height).toBe(300);

    // 300ms rebaseline path still runs afterward.
    h.win.flushTimers();
    h.frame();
    settleHeight(h);
    expect(h.last()).toEqual({ x: 0, y: 0, width: 0, height: 0 });
  });

  test("focusout clears immediately without waiting 80ms", () => {
    const h = setup();
    focus(h, input());
    shrinkViewport(h, 544);
    expect(h.last().height).toBe(300);

    // Start a new pending candidate, then blur before it can commit.
    shrinkViewport(h, 400, { settle: false });
    expect(h.last().height).toBe(300);

    h.doc.activeElement = null;
    h.doc.emit("focusout");
    h.frame(); // immediate zeros — no advanceTimers
    expect(h.last()).toEqual({ x: 0, y: 0, width: 0, height: 0 });
    expect(h.win.pendingTimers()).toBe(0);
  });
});

describe("Rule 2 dual metrics (physical rect vs CSS remainder)", () => {
  test("(i) scroll-compensated: rect reports keyboard, remainder is 0", () => {
    // Baseline at focus: vv.height 800, offsetTop 0 (baselineBottom 800).
    const h = setup({ innerWidth: 390, innerHeight: 800 });
    focus(h, input());

    // iOS-26 evidence: Safari shrinks vv AND scrolls it so the sum is unchanged.
    // 507 + 293 === 800 -> keyboard fully compensated.
    moveViewport(h, 507, 293);
    expect(h.last().height).toBe(293); // physical keyboard -> boundingRect
    expect(h.lastRemainder()).toBe(0); // nothing left to lift -> CSS props 0
  });

  test("(ii) WKWebView both-shrink (offsetTop stays 0): trueHeight === remainder", () => {
    const h = setup({ innerWidth: 390, innerHeight: 800 });
    focus(h, input());

    // No scroll compensation: only vv.height shrinks, offsetTop stays 0.
    moveViewport(h, 507, 0);
    expect(h.last().height).toBe(293);
    expect(h.lastRemainder()).toBe(293); // the two metrics coincide
    expect(h.lastRemainder()).toBe(h.last().height);
  });

  test("(iii) partial compensation: rect 293, remainder 40", () => {
    const h = setup({ innerWidth: 390, innerHeight: 800 });
    focus(h, input());

    // Browser revealed 253px of the keyboard by scrolling; 40px still uncovered.
    moveViewport(h, 507, 253);
    expect(h.last().height).toBe(293); // physical keyboard unchanged
    expect(h.lastRemainder()).toBe(40); // 800 - 507 - 253
  });
});
