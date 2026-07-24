/**
 * CSS custom-property / inset tests. `computeInsets`/`writeKeyboardInsetProps`
 * take the `remainder` (the uncovered layout bottom in px, Rule 2 dual metrics),
 * NOT a rect. They describe a bottom-docked band of height `remainder`. Covers
 * the docked-band invariant top + height + bottom === innerHeight and the
 * remainder === 0 -> all-zeros default.
 */

import { test, expect, describe } from "bun:test";
import { computeInsets, writeKeyboardInsetProps } from "../src/css-properties.ts";
import { FakeDocument } from "./fakes.ts";

const viewport = { innerWidth: 390, innerHeight: 844 };

describe("computeInsets", () => {
  test("docked band: invariant top + height + bottom === innerHeight", () => {
    const insets = computeInsets(300, viewport);
    expect(insets.top + insets.height + insets.bottom).toBe(viewport.innerHeight);
  });

  test("docked band: left=0, right=0, bottom=0, width=innerWidth", () => {
    const insets = computeInsets(300, viewport);
    expect(insets.left).toBe(0);
    expect(insets.right).toBe(0);
    expect(insets.bottom).toBe(0);
    expect(insets.width).toBe(viewport.innerWidth);
    expect(insets.height).toBe(300);
    expect(insets.top).toBe(844 - 300);
  });

  test("remainder 0 (nothing to lift) -> all six insets are zero", () => {
    const insets = computeInsets(0, viewport);
    expect(insets).toEqual({ top: 0, right: 0, bottom: 0, left: 0, width: 0, height: 0 });
  });

  test("insets never go negative", () => {
    // Remainder taller than the viewport should still clamp top/bottom at 0.
    const insets = computeInsets(900, viewport);
    expect(insets.top).toBeGreaterThanOrEqual(0);
    expect(insets.bottom).toBeGreaterThanOrEqual(0);
    expect(insets.right).toBeGreaterThanOrEqual(0);
  });

  test("invariant holds across a range of remainders", () => {
    for (const h of [1, 50, 250, 300, 421, 843]) {
      const insets = computeInsets(h, viewport);
      expect(insets.top + insets.height + insets.bottom).toBe(viewport.innerHeight);
    }
  });
});

describe("writeKeyboardInsetProps", () => {
  test("writes all six --keyboard-inset-* props as px strings", () => {
    const doc = new FakeDocument();
    writeKeyboardInsetProps(doc, 300, viewport);
    const s = doc.documentElement.style;
    expect(s.get("--keyboard-inset-top")).toBe("544px");
    expect(s.get("--keyboard-inset-right")).toBe("0px");
    expect(s.get("--keyboard-inset-bottom")).toBe("0px");
    expect(s.get("--keyboard-inset-left")).toBe("0px");
    expect(s.get("--keyboard-inset-width")).toBe("390px");
    expect(s.get("--keyboard-inset-height")).toBe("300px");
  });

  test("remainder 0 writes zeros for all six", () => {
    const doc = new FakeDocument();
    writeKeyboardInsetProps(doc, 0, viewport);
    const s = doc.documentElement.style;
    for (const p of ["top", "right", "bottom", "left", "width", "height"]) {
      expect(s.get(`--keyboard-inset-${p}`)).toBe("0px");
    }
  });

  test("no-op when documentElement is null (SSR-safe)", () => {
    const doc = { documentElement: null } as unknown as import("../src/css-properties.ts").StyleTarget;
    expect(() => writeKeyboardInsetProps(doc, 300, viewport)).not.toThrow();
  });
});
