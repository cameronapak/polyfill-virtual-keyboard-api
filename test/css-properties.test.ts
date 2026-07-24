/**
 * CSS custom-property / inset tests. Covers SPEC scenario 10 (inset
 * consistency, geometry Rule 7) and the docked-keyboard invariant
 * top + height + bottom === innerHeight, plus the hidden->all-zeros default.
 */

import { test, expect, describe } from "bun:test";
import { computeInsets, writeKeyboardInsetProps } from "../src/css-properties.ts";
import type { RectValue } from "../src/geometry.ts";
import { FakeDocument } from "./fakes.ts";

const viewport = { innerWidth: 390, innerHeight: 844 };

function dockedRect(height: number): RectValue {
  return { x: 0, y: viewport.innerHeight - height, width: viewport.innerWidth, height };
}

describe("computeInsets", () => {
  test("docked keyboard: invariant top + height + bottom === innerHeight", () => {
    const insets = computeInsets(dockedRect(300), viewport);
    expect(insets.top + insets.height + insets.bottom).toBe(viewport.innerHeight);
  });

  test("docked keyboard: left=0, right=0, bottom=0, width=innerWidth", () => {
    const insets = computeInsets(dockedRect(300), viewport);
    expect(insets.left).toBe(0);
    expect(insets.right).toBe(0);
    expect(insets.bottom).toBe(0);
    expect(insets.width).toBe(viewport.innerWidth);
    expect(insets.height).toBe(300);
    expect(insets.top).toBe(844 - 300);
  });

  test("hidden keyboard (empty rect) -> all six insets are zero", () => {
    const insets = computeInsets({ x: 0, y: 0, width: 0, height: 0 }, viewport);
    expect(insets).toEqual({ top: 0, right: 0, bottom: 0, left: 0, width: 0, height: 0 });
  });

  test("insets never go negative", () => {
    // Height taller than viewport should still clamp bottom at 0.
    const insets = computeInsets(dockedRect(900), viewport);
    expect(insets.bottom).toBeGreaterThanOrEqual(0);
    expect(insets.right).toBeGreaterThanOrEqual(0);
  });

  test("invariant holds across a range of heights", () => {
    for (const h of [1, 50, 250, 300, 421, 843]) {
      const insets = computeInsets(dockedRect(h), viewport);
      expect(insets.top + insets.height + insets.bottom).toBe(viewport.innerHeight);
    }
  });
});

describe("writeKeyboardInsetProps", () => {
  test("writes all six --keyboard-inset-* props as px strings", () => {
    const doc = new FakeDocument();
    writeKeyboardInsetProps(doc, dockedRect(300), viewport);
    const s = doc.documentElement.style;
    expect(s.get("--keyboard-inset-top")).toBe("544px");
    expect(s.get("--keyboard-inset-right")).toBe("0px");
    expect(s.get("--keyboard-inset-bottom")).toBe("0px");
    expect(s.get("--keyboard-inset-left")).toBe("0px");
    expect(s.get("--keyboard-inset-width")).toBe("390px");
    expect(s.get("--keyboard-inset-height")).toBe("300px");
  });

  test("hidden keyboard writes zeros for all six", () => {
    const doc = new FakeDocument();
    writeKeyboardInsetProps(doc, { x: 0, y: 0, width: 0, height: 0 }, viewport);
    const s = doc.documentElement.style;
    for (const p of ["top", "right", "bottom", "left", "width", "height"]) {
      expect(s.get(`--keyboard-inset-${p}`)).toBe("0px");
    }
  });

  test("no-op when documentElement is null (SSR-safe)", () => {
    const doc = { documentElement: null } as unknown as import("../src/css-properties.ts").StyleTarget;
    expect(() => writeKeyboardInsetProps(doc, dockedRect(300), viewport)).not.toThrow();
  });
});
