import { describe, expect, it, vi } from "vitest";

import { handleComboChat } from "../../open-sse/services/combo.js";
import {
  containsDsmlProtocolLeak,
  createDsmlLeakDetector,
  preflightDsmlResponse,
} from "../../open-sse/utils/dsmlGuard.js";
import { createPassthroughStreamWithLogger } from "../../open-sse/utils/stream.js";

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

  it("falls back when the first DSML marker is split across SSE deltas", async () => {
    const broken = [sse({ content: "</inv" }), sse({ content: "oke>" })];
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

describe("DeepSeek DSML passthrough circuit breaker", () => {
  it("errors instead of forwarding a late DSML leak", async () => {
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

    await expect(consume()).rejects.toThrow(/DSML/i);
    expect(forwarded).toContain("healthy prefix");
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
