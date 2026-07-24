## Learned User Preferences

- Prefer AskQuestion for clarifying questions; escalate unresolved fog with `batch-grill-me` or `grill-with-docs`.
- Stay high-level as orchestrator; spin Cursor Auto subagents for implementation work.
- When grilling, pick the best reasonable option: favor robustness and best practices, avoid over-optimizing; user is often impartial and trusts agent defaults.
- Keep wayfinder maps, tickets, and research as Markdown under `.scratch/` in this repo.
- For iOS Simulator / device runs in Cursor, use `agent-device` and Device hub.

## Learned Workspace Facts

- Package `virtual-keyboard-api-polyfill` polyfills VirtualKeyboard geometry for Safari/iOS/WKWebView/Firefox; native passthrough when the engine already implements `navigator.virtualKeyboard`.
- Safari chat-UI Recipe ships as `virtual-keyboard-api-polyfill/ios-composer` (`attachIosComposer`); not installed by `/auto`; vanilla helpers only (no framework deps in the published package).
- Wayfinder tracker lives at `.scratch/safari-vk-polyfill/` (map, issues, research, prototypes); domain glossary is `CONTEXT.md`.
- Docs split: `SPEC.md` = polyfill; `docs/ios-composer.md` = Recipe; README links both.
- Standing constraints: never fake `overlaysContent = false`; `virtualKeyboardPolicy` out of v1; settle filter is 80ms height stability plus 300ms rebaseline; pre-lift and scroll containment belong in the Recipe, not the Geometry engine.
- v1 destination: decision-locked SPEC + npm-shippable geometry polyfill + endorsed Safari fixed-composer Recipe; chat-UI readiness still needs the manual device acceptance checklist.
