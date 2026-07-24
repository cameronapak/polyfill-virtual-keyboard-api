/**
 * `/auto` side-effect entry tests (SPEC scenario 7).
 *
 * auto.ts runs its install logic at import time and reads the bare globals
 * `window` / `navigator` / `document`. Bun caches modules, so each case imports
 * with a unique query string to force a fresh evaluation. We stub the globals
 * before each import and tear them down afterward.
 */

import { test, expect, describe, afterEach } from "bun:test";
import { FakeWindow, FakeDocument, FakeVisualViewport } from "./fakes.ts";

let bust = 0;

function importAuto(): Promise<{ default: unknown }> {
  bust += 1;
  return import(`../src/auto.ts?t=${bust}`) as Promise<{ default: unknown }>;
}

function makeGlobals(navigator: Record<string, unknown>): FakeWindow {
  const vv = new FakeVisualViewport({ width: 390, height: 844 });
  const win = new FakeWindow({
    innerWidth: 390,
    innerHeight: 844,
    visualViewport: vv,
    navigator: { maxTouchPoints: 5 },
  });
  const doc = new FakeDocument();
  Object.defineProperty(globalThis, "window", { value: win, configurable: true, writable: true });
  Object.defineProperty(globalThis, "document", { value: doc, configurable: true, writable: true });
  Object.defineProperty(globalThis, "navigator", {
    value: navigator,
    configurable: true,
    writable: true,
  });
  return win;
}

function clearGlobals(): void {
  for (const key of ["window", "document", "navigator"]) {
    if (Object.getOwnPropertyDescriptor(globalThis, key)) {
      delete (globalThis as Record<string, unknown>)[key];
    }
  }
}

afterEach(() => {
  clearGlobals();
});

describe("/auto installs the polyfill when native is missing", () => {
  test("defines navigator.virtualKeyboard and exports the instance", async () => {
    const nav: Record<string, unknown> = { maxTouchPoints: 5 };
    makeGlobals(nav);
    const mod = await importAuto();

    expect("virtualKeyboard" in nav).toBe(true);
    const installed = nav.virtualKeyboard as { isPolyfill?: boolean };
    expect(installed.isPolyfill).toBe(true);
    // The default export is the same installed instance (for debuggability).
    expect(mod.default).toBe(installed as unknown);
  });

  test("navigator.virtualKeyboard is configurable (defined once, replaceable)", async () => {
    const nav: Record<string, unknown> = { maxTouchPoints: 5 };
    makeGlobals(nav);
    await importAuto();
    const desc = Object.getOwnPropertyDescriptor(nav, "virtualKeyboard");
    expect(desc?.configurable).toBe(true);
    expect(desc?.enumerable).toBe(true);
  });
});

describe("/auto respects an existing native implementation", () => {
  test("does not overwrite navigator.virtualKeyboard when present", async () => {
    const native = { __native: true, boundingRect: {}, overlaysContent: true };
    const nav: Record<string, unknown> = { maxTouchPoints: 5, virtualKeyboard: native };
    makeGlobals(nav);
    const mod = await importAuto();

    expect(nav.virtualKeyboard).toBe(native);
    expect((nav.virtualKeyboard as { __native?: boolean }).__native).toBe(true);
    // Nothing installed -> default export is undefined.
    expect(mod.default).toBeUndefined();
  });
});

describe("/auto is import-safe without a browser environment", () => {
  test("does nothing and does not throw when window is undefined", async () => {
    clearGlobals(); // no window/navigator/document at all
    const mod = await importAuto();
    expect(mod.default).toBeUndefined();
  });

  test("does nothing when navigator is undefined even if window exists", async () => {
    const vv = new FakeVisualViewport({ width: 390, height: 844 });
    const win = new FakeWindow({
      innerWidth: 390,
      innerHeight: 844,
      visualViewport: vv,
      navigator: { maxTouchPoints: 5 },
    });
    Object.defineProperty(globalThis, "window", { value: win, configurable: true, writable: true });
    // navigator intentionally absent.
    clearNavigator();
    const mod = await importAuto();
    expect(mod.default).toBeUndefined();
  });
});

function clearNavigator(): void {
  if (Object.getOwnPropertyDescriptor(globalThis, "navigator")) {
    delete (globalThis as Record<string, unknown>)["navigator"];
  }
}
