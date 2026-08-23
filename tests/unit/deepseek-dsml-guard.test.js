import { describe, expect, it, vi } from "vitest";
import "../translator/registerAll.js";
import { FORMATS } from "../../open-sse/translator/formats.js";

import { handleComboChat } from "../../open-sse/services/combo.js";
import {
  containsDsmlProtocolLeak,
  createDsmlLeakDetector,
  preflightDsmlResponse,
} from "../../open-sse/utils/dsmlGuard.js";
import { createPassthroughStreamWithLogger, createSSETransformStreamWithLogger } from "../../open-sse/utils/stream.js";
import { createStreamController, pipeWithDisconnect } from "../../open-sse/utils/streamHandler.js";
import { buildStreamErrorBytes } from "../../open-sse/utils/streamHelpers.js";

const encoder = new TextEncoder();

function sse(delta, finishReason = null) {
  return `data: ${JSON.stringify({
    id: "chatcmpl-test",
    choices: [{ delta, finish_reason: finishReason }],
  })}\n\n`;
}

function sseResponse(parts, { onCancel } = {}) {
  const body = new ReadableStream({
    start(controller) {
      for (const part of parts) controller.enqueue(encoder.encode(part));
      if (!onCancel) controller.close();
    },
    cancel(reason) {
      onCancel?.(reason);
    },
  });
  return new Response(body, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

const guardedBody = {
  stream: true,
  tools: [{ type: "function", function: { name: "web_search" } }],
};
const guardedModel = "nebius/deepseek-ai/DeepSeek-V4-Flash(max)";

describe("DeepSeek DSML detection", () => {
  it.each(["<invoke", "</invoke", "<parameter", "<tool_calls", "<｜DSML｜", "<｜DSML｜invoke", "</|DSML|tool_calls"])("holds complete marker prefix %s", (prefix) => {
    const detector = createDsmlLeakDetector();
    expect(detector.push(prefix)).toBe(false);
    expect(detector.hasPendingMarker()).toBe(true);
  });
  it.each([
    "<｜DSML｜tool_calls>",
    "</｜DSML｜tool_calls>",
    '<invoke name="web_search">',
    "</invoke>",
    '<｜DSML｜invoke name="web_search">',
  ])("detects leaked protocol marker %s", (text) => {
    expect(containsDsmlProtocolLeak(text)).toBe(true);
  });

  it("does not flag ordinary prose using the word invoke", () => {
    expect(containsDsmlProtocolLeak("The runtime may invoke a tool.")).toBe(false);
  });

  it("detects a marker split across streamed content", () => {
    const detector = createDsmlLeakDetector();
    expect(detector.push("answer</inv")).toBe(false);
    expect(detector.push("oke>tail")).toBe(true);
  });
});

describe("DeepSeek DSML response preflight", () => {
  it("replays a healthy text stream byte-for-byte", async () => {
    const raw = sse({ role: "assistant" }) + sse({ content: "hello" });
    const response = await preflightDsmlResponse(sseResponse([raw]), {
      body: guardedBody,
      model: guardedModel,
    });

    await expect(response.text()).resolves.toBe(raw);
  });

  it("replays a native structured tool call", async () => {
    const raw = sse({
      tool_calls: [{
        index: 0,
        id: "call_1",
        type: "function",
        function: { name: "web_search", arguments: '{"q":"test"}' },
      }],
    });
    const response = await preflightDsmlResponse(sseResponse([raw]), {
      body: guardedBody,
      model: guardedModel,
    });

    await expect(response.text()).resolves.toBe(raw);
  });

  it("does not drain the upstream before the client pulls", async () => {
    let pulls = 0;
    const upstream = new Response(new ReadableStream({
      pull(controller) {
        pulls += 1;
        if (pulls === 1) {
          controller.enqueue(encoder.encode(sse({ content: "hello" })));
        } else if (pulls <= 50) {
          controller.enqueue(encoder.encode(sse({ content: "more" })));
        } else {
          controller.close();
        }
      },
    }), {
      headers: { "Content-Type": "text/event-stream" },
    });

    const response = await preflightDsmlResponse(upstream, {
      body: guardedBody,
      model: guardedModel,
    });
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(pulls).toBeLessThan(10);
    await response.body.cancel();
  });

  it("cancels malformed DSML and lets a combo use its next model", async () => {
    let cancelled = false;
    const broken = sse({ content: "</｜DSML｜tool_calls>" });
    const handleSingleModel = vi.fn(async (_body, model) => {
      if (model === guardedModel) {
        return sseResponse([broken], { onCancel: () => { cancelled = true; } });
      }
      return new Response("fallback answer", { status: 200 });
    });
    const log = { info: vi.fn(), warn: vi.fn() };

    const response = await handleComboChat({
      body: guardedBody,
      models: [guardedModel, "openrouter/healthy"],
      handleSingleModel,
      log,
    });

    await expect(response.text()).resolves.toBe("fallback answer");
    expect(cancelled).toBe(true);
    expect(handleSingleModel).toHaveBeenCalledTimes(2);
  });

  it.each([["</inv", "oke>"], ["<invoke", ' name="search">']])("falls back for split marker %s / %s", async (prefix, suffix) => {
    const broken = [sse({ content: prefix }), sse({ content: suffix })];
    const handleSingleModel = vi.fn(async (_body, model) => {
      if (model === guardedModel) return sseResponse(broken);
      return new Response("fallback answer", { status: 200 });
    });
    const log = { info: vi.fn(), warn: vi.fn() };

    const response = await handleComboChat({
      body: guardedBody,
      models: [guardedModel, "openrouter/healthy"],
      handleSingleModel,
      log,
    });

    await expect(response.text()).resolves.toBe("fallback answer");
    expect(handleSingleModel).toHaveBeenCalledTimes(2);
  });
});

describe.each([FORMATS.CLAUDE, FORMATS.OPENAI_RESPONSES])("DSML with %s clients", (format) => {
  const event = (text) => format === FORMATS.CLAUDE
    ? { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } }
    : { type: "response.output_text.delta", output_index: 0, delta: text };
  const encodeEvent = (text) => `data: ${JSON.stringify(event(text))}\n\n`;

  it("releases healthy text while the upstream is still open", async () => {
    let source;
    const upstream = new Response(new ReadableStream({
      start(controller) {
        source = controller;
        controller.enqueue(encoder.encode(encodeEvent("hello")));
      },
    }), { headers: { "Content-Type": "text/event-stream" } });
    const pending = preflightDsmlResponse(upstream, { body: guardedBody, model: guardedModel });
    let response;
    try {
      pending.then(value => { response = value; });
      await vi.waitFor(() => expect(response).toBeDefined(), { timeout: 300 });
    } finally {
      source.close();
      await (await pending).body.cancel();
    }
  });

  it("rejects DSML in already-translated events", async () => {
    await expect(preflightDsmlResponse(sseResponse([encodeEvent("<invoke name=search>")]), {
      body: guardedBody, model: guardedModel,
    })).rejects.toThrow(/DSML/);
  });

  it("falls back through the real response translator", async () => {
    const handleSingleModel = vi.fn(async (_body, model) => {
      if (model !== guardedModel) return new Response("fallback");
      return new Response(sseResponse([sse({ content: "<invoke name=search>" })]).body.pipeThrough(
        createSSETransformStreamWithLogger(FORMATS.OPENAI, format, "test", null, null, guardedModel, null, guardedBody),
      ), { headers: { "Content-Type": "text/event-stream" } });
    });
    const response = await handleComboChat({ body: guardedBody, models: [guardedModel, "healthy"], handleSingleModel, log: { info: vi.fn(), warn: vi.fn() } });
    expect(await response.text()).toBe("fallback");
  });

  it("ends late leaks with a DSML error frame in the translation path", async () => {
    const response = new Response(sseResponse([sse({ content: "hello" }), sse({ content: "</invoke>" })]).body.pipeThrough(
      createSSETransformStreamWithLogger(FORMATS.OPENAI, format, "test", null, null, guardedModel, null, guardedBody),
    ));
    const text = await response.text();
    expect(text).toContain("DSML");
    expect(text).not.toContain("</invoke>");
  });

  it("stops at a final leaked data line without a newline", async () => {
    const response = new Response(sseResponse([sse({ content: "</invoke>" }).trimEnd()]).body.pipeThrough(
      createSSETransformStreamWithLogger(FORMATS.OPENAI, format, "test", null, null, guardedModel, null, guardedBody),
    ));
    const text = await response.text();
    expect(text).toContain("DSML");
    expect(text).not.toContain("</invoke>");
  });
});

describe("DeepSeek DSML passthrough circuit breaker", () => {
  it("stops with a DSML error instead of forwarding a late leak", async () => {
    const upstream = sseResponse([
      sse({ content: "healthy prefix" }),
      sse({ content: "</invoke>" }),
    ]);
    const guarded = upstream.body.pipeThrough(
      createPassthroughStreamWithLogger(
        "github",
        null,
        guardedModel,
        null,
        guardedBody,
      ),
    );
    const reader = guarded.getReader();
    const decoder = new TextDecoder();
    let forwarded = "";
    const consume = async () => {
      while (true) {
        const { done, value } = await reader.read();
        if (done) return;
        forwarded += decoder.decode(value, { stream: true });
      }
    };

    await consume();
    expect(forwarded).toContain("healthy prefix");
    expect(forwarded).toContain("DSML");
    expect(forwarded).not.toContain("</invoke>");
  });

  it("does not guard tool-free requests", async () => {
    const raw = sse({ content: "Example: </invoke>" });
    const upstream = sseResponse([raw]);
    const passthrough = upstream.body.pipeThrough(
      createPassthroughStreamWithLogger(
        "github",
        null,
        guardedModel,
        null,
        { stream: true },
      ),
    );

    const output = await new Response(passthrough).text();
    expect(output).toContain("Example: </invoke>");
  });

  it("does not guard other model families", async () => {
    const raw = sse({ content: "Example: </invoke>" });
    const response = await preflightDsmlResponse(sseResponse([raw]), {
      body: guardedBody,
      model: "openai/gpt-5.4",
    });

    await expect(response.text()).resolves.toBe(raw);
  });
});

// Mirrors chatCore/streamingHandler: the translate stream is wrapped by
// pipeWithDisconnect with an abort terminal, so a transform error never reaches
// the combo as a stream error.
function productionStream(parts, format = FORMATS.OPENAI) {
  const transform = createSSETransformStreamWithLogger(FORMATS.OPENAI, format, "test", null, null, guardedModel, null, guardedBody);
  const controller = createStreamController({ provider: "test", model: guardedModel });
  const body = pipeWithDisconnect(sseResponse(parts), transform, controller, (message) => buildStreamErrorBytes(504, message, format));
  return new Response(body, { headers: { "Content-Type": "text/event-stream" } });
}

describe.each([FORMATS.OPENAI, FORMATS.CLAUDE])("DSML through the production stream pipeline (%s client)", (format) => {
  it.each([
    [["<invoke name=search>"]],
    [["<invoke", ' name="search">']],
    [["</inv", "oke>"]],
  ])("falls back when the first content leaks %j", async (contents) => {
    const handleSingleModel = vi.fn(async (_body, model) => {
      if (model !== guardedModel) return new Response("fallback answer");
      return productionStream(contents.map((content) => sse({ content })), format);
    });
    const response = await handleComboChat({ body: guardedBody, models: [guardedModel, "healthy"], handleSingleModel, log: { info: vi.fn(), warn: vi.fn() } });
    expect(await response.text()).toBe("fallback answer");
    expect(handleSingleModel).toHaveBeenCalledTimes(2);
  });

  it("ends a late leak with a DSML error frame instead of a connection-lost error", async () => {
    const text = await productionStream([sse({ content: "hello" }), sse({ content: "</invoke>" })], format).text();
    expect(text).toContain("hello");
    expect(text).toContain("DSML");
    expect(text).not.toContain("</invoke>");
    expect(text).not.toContain("upstream connection lost");
  });
});
