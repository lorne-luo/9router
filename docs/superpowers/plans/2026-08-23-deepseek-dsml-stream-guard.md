# DeepSeek DSML Stream Guard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop malformed DeepSeek V4 DSML from flooding clients, fall back to the next 9router combo model when detection happens before release, and make QwenPaw reject any leaked protocol without executing it.

**Architecture:** A small side-effect-free DSML detector is shared by 9router's combo preflight and passthrough stream. The combo preflight buffers only the beginning of eligible SSE responses and replays it byte-for-byte when healthy; QwenPaw independently scans DeepSeek V4 stream text with a rolling tail and raises a named compatibility error.

**Tech Stack:** JavaScript Web Streams and Vitest in 9router; Python async generators, AgentScope response blocks, and pytest in QwenPaw.

---

### Task 1: 9router detector and preflight fallback

**Files:**
- Create: `open-sse/utils/dsmlGuard.js`
- Modify: `open-sse/services/combo.js`
- Create: `tests/unit/deepseek-dsml-guard.test.js`

- [ ] **Step 1: Write failing detector and combo tests**

Create SSE helpers and tests proving that canonical/full-width and malformed
plain invoke tags are detected across chunks, healthy text is replayed exactly,
structured `delta.tool_calls` is replayed, and `handleComboChat` cancels the
broken first response then returns the healthy second response.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `npx vitest run tests/unit/deepseek-dsml-guard.test.js`

Expected: failure because `open-sse/utils/dsmlGuard.js` and its exports do not
exist.

- [ ] **Step 3: Implement the detector and replaying preflight**

Implement:

```js
export class DsmlProtocolError extends Error {}
export function containsDsmlProtocolLeak(text) {}
export function shouldGuardDsml(body, model) {}
export function createDsmlLeakDetector() {}
export async function preflightDsmlResponse(response, { body, model }) {}
```

`preflightDsmlResponse` must bypass ineligible/non-SSE responses, read complete
SSE data lines until the first content/tool-call/finish semantic event or a
small byte ceiling, cancel and throw on DSML content, and otherwise return a
new `Response` whose body emits every buffered byte before pumping the same
reader. `handleComboChat` calls it before declaring a 2xx candidate successful;
its existing exception path performs fallback.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run: `npx vitest run tests/unit/deepseek-dsml-guard.test.js`

Expected: all tests pass.

### Task 2: 9router late-stream circuit breaker

**Files:**
- Modify: `open-sse/utils/stream.js`
- Modify: `tests/unit/deepseek-dsml-guard.test.js`

- [ ] **Step 1: Add a failing late-leak test**

Build an eligible passthrough stream that first emits healthy text and later a
DSML closing/invoke marker. Assert the healthy prefix is readable but consuming
the remainder rejects with `DsmlProtocolError`; assert non-DeepSeek and
tool-free requests pass the same literal text unchanged.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `npx vitest run tests/unit/deepseek-dsml-guard.test.js`

Expected: the leaked DSML is still forwarded.

- [ ] **Step 3: Add the passthrough detector**

Instantiate a rolling detector only when `shouldGuardDsml(body, model)` is true.
Before accumulating or forwarding `delta.content`, feed it to the detector and
call `controller.error(new DsmlProtocolError(...))` on a match. Do not log raw
content or attempt DSML-to-tool conversion.

- [ ] **Step 4: Run focused and adjacent tests**

Run: `npx vitest run tests/unit/deepseek-dsml-guard.test.js tests/unit/combo-autoswitch.test.js tests/unit/finish-reason-concern.test.js`

Expected: all tests pass.

### Task 3: QwenPaw final protocol guard

**Files:**
- Modify: `src/qwenpaw/local_models/tag_parser.py`
- Modify: `src/qwenpaw/providers/openai_chat_model_compat.py`
- Modify: `tests/unit/local_models/test_tag_parser.py`
- Modify: `tests/unit/providers/test_openai_stream_toolcall_compat.py`

- [ ] **Step 1: Add failing detector and stream tests**

Add table tests for canonical DSML, malformed `<invoke name=...>` and
`</invoke>`, split tags, and ordinary prose containing the word `invoke`. Add
an async provider test asserting a DeepSeek V4 stream raises
`DSMLProtocolError` and produces no `ToolCallBlock`; a dummy non-DeepSeek model
must remain unaffected.

- [ ] **Step 2: Run focused pytest and verify RED**

Run: `pytest -q tests/unit/local_models/test_tag_parser.py tests/unit/providers/test_openai_stream_toolcall_compat.py`

Expected: import or assertion failures for the missing detector/error.

- [ ] **Step 3: Implement rolling detection and rejection**

Add `contains_dsml_protocol_leak()` and a bounded `DSMLLeakDetector` that keeps
only enough suffix to recognize a marker split across chunks. Add a named
`DSMLProtocolError(RuntimeError)`. In `_parse_stream_response`, for DeepSeek V4
or DeepSeek Flash model names, scan text and thinking blocks before existing
`<tool_call>` recovery and raise on detection. Never translate DSML into a
tool call.

- [ ] **Step 4: Run focused pytest and verify GREEN**

Run: `pytest -q tests/unit/local_models/test_tag_parser.py tests/unit/providers/test_openai_stream_toolcall_compat.py`

Expected: all tests pass.

### Task 4: Cross-repository verification and commits

**Files:**
- Verify every file listed above plus the design and plan documents.

- [ ] **Step 1: Run 9router verification**

Run: `npm --prefix tests test -- --run tests/unit/deepseek-dsml-guard.test.js tests/unit/combo-autoswitch.test.js tests/unit/finish-reason-concern.test.js`

Then run: `npm run build`

Expected: zero test failures and build exit 0.

- [ ] **Step 2: Run QwenPaw verification**

Run: `pytest -q tests/unit/local_models/test_tag_parser.py tests/unit/providers/test_openai_stream_toolcall_compat.py`

Then run the repository's configured lint/type checks that cover the modified
files.

Expected: zero failures.

- [ ] **Step 3: Review diffs and tracked scope**

Run `git diff --check`, inspect `git diff`, and verify existing unrelated
untracked files are not staged in either repository.

- [ ] **Step 4: Commit 9router**

Stage only the DSML guard, tests, combo/stream changes, and the two forced-added
ignored documentation files. Commit with:

```text
fix(stream): fall back on leaked DeepSeek DSML
```

- [ ] **Step 5: Commit QwenPaw**

Stage only the parser/provider changes and their tests. Commit with:

```text
fix(providers): stop leaked DeepSeek DSML streams
```

