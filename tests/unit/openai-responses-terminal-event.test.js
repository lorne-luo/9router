import { describe, expect, it } from "vitest";

import { FORMATS } from "../../open-sse/translator/formats.js";
import { initState } from "../../open-sse/translator/index.js";
import { openaiToOpenAIResponsesResponse } from "../../open-sse/translator/response/openai-responses.js";
import { createSSETransformStreamWithLogger } from "../../open-sse/utils/stream.js";

async function runTransform(input) {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(input));
      controller.close();
    },
  });

  const output = stream.pipeThrough(
    createSSETransformStreamWithLogger(
      FORMATS.OPENAI_RESPONSES,
      FORMATS.OPENAI_RESPONSES,
      "codex",
      null,
      null,
      "gpt-5.5",
    ),
  );

  const reader = output.getReader();
  const decoder = new TextDecoder();
  let text = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }

  text += decoder.decode();
  return text;
}

describe("OpenAI Responses streaming termination", () => {
  it("emits a response.failed event when a Responses stream closes before a terminal event", async () => {
    const output = await runTransform([
      `event: response.created`,
      `data: ${JSON.stringify({ type: "response.created", response: { id: "resp_test", status: "in_progress" } })}`,
      "",
      `event: response.output_text.delta`,
      `data: ${JSON.stringify({ type: "response.output_text.delta", delta: "partial" })}`,
      "",
    ].join("\n"));

    expect(output).toContain("event: response.failed");
    expect(output).toContain('"type":"response.failed"');
    expect(output).not.toContain("data: null");
    expect(output).toContain("data: [DONE]");
  });

  it("does not add response.failed when a Responses stream already completed", async () => {
    const output = await runTransform([
      `event: response.completed`,
      `data: ${JSON.stringify({ type: "response.completed", response: { id: "resp_test", status: "completed" } })}`,
      "",
    ].join("\n"));

    expect(output).toContain("event: response.completed");
    expect(output).not.toContain("event: response.failed");
    expect(output).not.toContain("data: null");
    expect(output).toContain("data: [DONE]");
  });

  it("does not add response.failed when a Responses stream sends response.done", async () => {
    const output = await runTransform([
      `event: response.done`,
      `data: ${JSON.stringify({ type: "response.done", response: { id: "resp_test" } })}`,
      "",
    ].join("\n"));

    expect(output).toContain("event: response.done");
    expect(output).not.toContain("event: response.failed");
    expect(output).not.toContain("data: null");
    expect(output).toContain("data: [DONE]");
  });

  it("emits response.failed before DONE when a Responses stream sends DONE without a terminal event", async () => {
    const output = await runTransform([
      `event: response.created`,
      `data: ${JSON.stringify({ type: "response.created", response: { id: "resp_test", status: "in_progress" } })}`,
      "",
      "data: [DONE]",
      "",
    ].join("\n"));

    expect(output.indexOf("event: response.failed")).toBeLessThan(output.indexOf("data: [DONE]"));
    expect(output.match(/data: \[DONE\]/g)).toHaveLength(1);
    expect(output).not.toContain("data: null");
  });
});

describe("response.completed response object completeness", () => {
  it("carries output, model and usage on the terminal completed event", () => {
    const state = initState(FORMATS.OPENAI_RESPONSES);
    state.model = "free";
    state.usage = { prompt_tokens: 11, completion_tokens: 2, total_tokens: 13 };

    const chunks = [
      { id: "cmpl-x", model: "free", choices: [{ index: 0, delta: { content: "hi" }, finish_reason: null }] },
      { id: "cmpl-x", model: "free", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
    ];

    const events = chunks.flatMap((chunk) => openaiToOpenAIResponsesResponse(chunk, state));
    const completed = events.find((e) => e.event === "response.completed");

    expect(completed).toBeTruthy();
    expect(completed.data.response).toMatchObject({
      id: state.responseId,
      object: "response",
      status: "completed",
      model: "free",
      usage: { prompt_tokens: 11, completion_tokens: 2, total_tokens: 13 },
    });
    expect(completed.data.response.output).toEqual([
      {
        id: `msg_${state.responseId}_0`,
        type: "message",
        content: [{ type: "output_text", annotations: [], logprobs: [], text: "hi" }],
        role: "assistant",
      },
    ]);
  });

  it("emits an empty output array when the stream had no output items", () => {
    const state = initState(FORMATS.OPENAI_RESPONSES);
    state.model = "free";

    const events = [
      { id: "cmpl-empty", model: "free", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
    ].flatMap((chunk) => openaiToOpenAIResponsesResponse(chunk, state));
    const completed = events.find((e) => e.event === "response.completed");

    expect(completed.data.response.output).toEqual([]);
    expect(completed.data.response.model).toBe("free");
  });
});
