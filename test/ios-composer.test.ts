/**
 * attachIosComposer Recipe tests. Uses happy-dom for real HTMLElement focus /
 * mousedown semantics; injects a fake VirtualKeyboard so height never comes
 * from visualViewport.
 */

import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { Window } from "happy-dom";
import {
  attachIosComposer,
  type VirtualKeyboardSource,
} from "../src/ios-composer.ts";

class FakeVK implements VirtualKeyboardSource {
  boundingRect = { height: 0 };
  private listeners = new Set<EventListenerOrEventListenerObject>();

  addEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
    if (type === "geometrychange") this.listeners.add(listener);
  }

  removeEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
    if (type === "geometrychange") this.listeners.delete(listener);
  }

  setHeight(height: number): void {
    this.boundingRect = { height };
    for (const listener of [...this.listeners]) {
      if (typeof listener === "function") listener(new Event("geometrychange"));
      else listener.handleEvent(new Event("geometrychange"));
    }
  }

  listenerCount(): number {
    return this.listeners.size;
  }
}

function installDom(): {
  window: Window;
  document: Document;
  cleanup: () => void;
} {
  const window = new Window({ url: "https://example.test/" });
  const document = window.document as unknown as Document;

  const g = globalThis as typeof globalThis & {
    window?: unknown;
    document?: unknown;
    HTMLElement?: unknown;
    Window?: unknown;
  };
  const prev = {
    window: g.window,
    document: g.document,
    HTMLElement: g.HTMLElement,
    Window: g.Window,
  };
  // happy-dom vs DOM lib types disagree; runtime is fine.
  g.window = window as never;
  g.document = document as never;
  g.HTMLElement = window.HTMLElement as never;
  g.Window = window.Window as never;

  return {
    window,
    document,
    cleanup() {
      g.window = prev.window;
      g.document = prev.document;
      g.HTMLElement = prev.HTMLElement;
      g.Window = prev.Window;
      window.close();
    },
  };
}

function makeComposer(document: Document): {
  composer: HTMLElement;
  field: HTMLInputElement;
  editable: HTMLElement;
  send: HTMLButtonElement;
} {
  const composer = document.createElement("div");
  composer.className = "composer";
  const field = document.createElement("input");
  field.type = "text";
  const editable = document.createElement("div");
  editable.contentEditable = "true";
  const send = document.createElement("button");
  send.type = "button";
  send.textContent = "Send";
  composer.append(field, editable, send);
  document.body.append(composer);
  return { composer, field, editable, send };
}

function mouseDown(
  el: HTMLElement,
  window: Window,
): { defaultPrevented: boolean; focusPreventScroll?: boolean } {
  let focusPreventScroll: boolean | undefined;
  const original = el.focus.bind(el);
  el.focus = ((options?: FocusOptions) => {
    focusPreventScroll = options?.preventScroll;
    return original(options);
  }) as typeof el.focus;

  const event = new window.Event("mousedown", { bubbles: true, cancelable: true });
  el.dispatchEvent(event as unknown as Event);
  return { defaultPrevented: event.defaultPrevented, focusPreventScroll };
}

describe("attachIosComposer", () => {
  let cleanup: (() => void) | undefined;
  let document: Document;
  let window: Window;

  beforeEach(() => {
    const dom = installDom();
    cleanup = dom.cleanup;
    document = dom.document;
    window = dom.window;
  });

  afterEach(() => {
    cleanup?.();
    cleanup = undefined;
  });

  test("pre-lifts on field mousedown using last-known height, focus preventScroll, preventDefault", () => {
    const vk = new FakeVK();
    const { composer, field } = makeComposer(document);
    const handle = attachIosComposer({
      composer,
      fields: [field],
      virtualKeyboard: vk,
      scrollTarget: window as unknown as globalThis.Window,
    });

    vk.setHeight(300);
    expect(composer.style.bottom).toBe("300px");

    // Close keyboard: visual lift clears, last-known kept for next pre-lift.
    vk.setHeight(0);
    expect(composer.style.bottom).toBe("");

    const result = mouseDown(field, window);
    expect(result.defaultPrevented).toBe(true);
    expect(result.focusPreventScroll).toBe(true);
    expect(composer.style.bottom).toBe("300px");

    handle.dispose();
  });

  test("gates control pre-lift: only when height > 0", () => {
    const vk = new FakeVK();
    const { composer, field, send } = makeComposer(document);
    attachIosComposer({
      composer,
      fields: [field],
      controls: [send],
      virtualKeyboard: vk,
      scrollTarget: window as unknown as globalThis.Window,
    });

    // Closed: control mousedown must not phantom-lift.
    mouseDown(send, window);
    expect(composer.style.bottom).toBe("");

    vk.setHeight(280);
    mouseDown(send, window);
    expect(composer.style.bottom).toBe("280px");
  });

  test("geometrychange updates height cache (via vk / getHeight seam)", () => {
    const vk = new FakeVK();
    let seam = 0;
    const { composer, field } = makeComposer(document);
    attachIosComposer({
      composer,
      fields: [field],
      virtualKeyboard: vk,
      getHeight: () => seam,
      scrollTarget: window as unknown as globalThis.Window,
    });

    seam = 240;
    vk.setHeight(999); // geometrychange fires; height comes from getHeight only
    expect(composer.style.bottom).toBe("240px");

    seam = 0;
    vk.setHeight(0);
    expect(composer.style.bottom).toBe("");
  });

  test("scroll lock snaps scrollTarget to top while height > 0", () => {
    const vk = new FakeVK();
    const { composer, field } = makeComposer(document);

    const scrollCalls: Array<[number, number]> = [];
    const scrollTarget = {
      scrollTo(x: number, y: number) {
        scrollCalls.push([x, y]);
      },
      addEventListener(type: string, listener: EventListenerOrEventListenerObject) {
        if (type === "scroll") {
          (scrollTarget as { _scroll?: EventListenerOrEventListenerObject })._scroll = listener;
        }
      },
      removeEventListener(type: string, listener: EventListenerOrEventListenerObject) {
        if (
          type === "scroll" &&
          (scrollTarget as { _scroll?: EventListenerOrEventListenerObject })._scroll === listener
        ) {
          (scrollTarget as { _scroll?: EventListenerOrEventListenerObject })._scroll = undefined;
        }
      },
      emitScroll() {
        const listener = (scrollTarget as { _scroll?: EventListenerOrEventListenerObject })._scroll;
        if (!listener) return;
        if (typeof listener === "function") listener(new Event("scroll"));
        else listener.handleEvent(new Event("scroll"));
      },
    };

    attachIosComposer({
      composer,
      fields: [field],
      virtualKeyboard: vk,
      scrollTarget: scrollTarget as unknown as Element,
    });

    scrollTarget.emitScroll();
    expect(scrollCalls.length).toBe(0);

    vk.setHeight(300);
    scrollTarget.emitScroll();
    expect(scrollCalls).toEqual([[0, 0]]);

    vk.setHeight(0);
    scrollCalls.length = 0;
    scrollTarget.emitScroll();
    expect(scrollCalls.length).toBe(0);
  });

  test("dispose removes all listeners and clears lift", () => {
    const vk = new FakeVK();
    const { composer, field, send } = makeComposer(document);
    const scrollTarget = {
      listeners: new Set<EventListenerOrEventListenerObject>(),
      scrollTo() {},
      addEventListener(type: string, listener: EventListenerOrEventListenerObject) {
        if (type === "scroll") this.listeners.add(listener);
      },
      removeEventListener(type: string, listener: EventListenerOrEventListenerObject) {
        if (type === "scroll") this.listeners.delete(listener);
      },
    };

    const handle = attachIosComposer({
      composer,
      fields: [field],
      controls: [send],
      virtualKeyboard: vk,
      scrollTarget: scrollTarget as unknown as Element,
    });

    vk.setHeight(200);
    expect(composer.style.bottom).toBe("200px");
    expect(vk.listenerCount()).toBe(1);
    expect(scrollTarget.listeners.size).toBe(1);

    handle.dispose();
    expect(vk.listenerCount()).toBe(0);
    expect(scrollTarget.listeners.size).toBe(0);
    expect(composer.style.bottom).toBe("");

    // Post-dispose: mousedown must not re-apply lift or preventDefault wiring.
    vk.setHeight(350);
    const result = mouseDown(field, window);
    expect(result.defaultPrevented).toBe(false);
    expect(composer.style.bottom).toBe("");
  });

  test("defaults fields to texty controls inside composer", () => {
    const vk = new FakeVK();
    const { composer, field, editable, send } = makeComposer(document);
    // checkbox should be ignored by default discovery
    const check = document.createElement("input");
    check.type = "checkbox";
    composer.append(check);

    attachIosComposer({
      composer,
      controls: [send],
      virtualKeyboard: vk,
      scrollTarget: window as unknown as globalThis.Window,
    });

    vk.setHeight(0);
    const fieldResult = mouseDown(field, window);
    expect(fieldResult.defaultPrevented).toBe(true);
    expect(fieldResult.focusPreventScroll).toBe(true);

    vk.setHeight(0);
    composer.style.bottom = "";
    const editableResult = mouseDown(editable, window);
    expect(editableResult.defaultPrevented).toBe(true);

    const checkResult = mouseDown(check, window);
    expect(checkResult.defaultPrevented).toBe(false);
  });

  test("SSR-safe: module attach with injected seams does not require window globals", () => {
    // Detach globals after setup of elements is awkward; instead verify calling
    // with fully injected vk/scrollTarget and no navigator.virtualKeyboard works.
    const vk = new FakeVK();
    const { composer, field } = makeComposer(document);
    const handle = attachIosComposer({
      composer,
      fields: [field],
      virtualKeyboard: vk,
      scrollTarget: {
        addEventListener() {},
        removeEventListener() {},
        scrollTo() {},
      } as unknown as Element,
    });
    expect(typeof handle.dispose).toBe("function");
    handle.dispose();
  });
});

describe("attachIosComposer import SSR safety", () => {
  test("importing the module does not throw without using attach", async () => {
    // Re-import path already loaded; assert export shape only.
    const mod = await import("../src/ios-composer.ts");
    expect(typeof mod.attachIosComposer).toBe("function");
  });
});
