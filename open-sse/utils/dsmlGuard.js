// Match protocol-shaped tags only; ordinary prose containing "invoke" is safe.
const DSML_MARKER_RE = /<\s*\/?\s*(?:(?:｜|\|)DSML(?:｜|\|)\s*)?(?:tool_calls|invoke|parameter)(?:\s|>|\/)/iu;
const DETECTOR_TAIL_LENGTH = 64;
// Bound preflight latency; the passthrough guard remains active after release.
const PREFLIGHT_BYTE_LIMIT = 16 * 1024;
const DSML_MARKER_PREFIXES = [
  "<invoke",
  "</invoke",
  "<parameter",
  "</parameter",
  "<tool_calls",
  "</tool_calls",
  "<｜dsml｜",
  "</｜dsml｜",
  "<|dsml|",
  "</|dsml|",
];

export class DsmlProtocolError extends Error {
  constructor(message = "Upstream leaked DeepSeek DSML in assistant content") {
    super(message);
    this.name = "DsmlProtocolError";
  }
}

export function containsDsmlProtocolLeak(text) {
  return typeof text === "string" && DSML_MARKER_RE.test(text);
}

export function shouldGuardDsml(body, model) {
  const tools = body?.tools || body?.request?.tools;
  if (!Array.isArray(tools) || tools.length === 0) return false;
  return typeof model === "string" && /deepseek.*(?:v4|flash)|(?:v4|flash).*deepseek/i.test(model);
}

export function createDsmlLeakDetector() {
  let tail = "";
  return {
    push(content) {
      if (typeof content !== "string" || content.length === 0) return false;
      const combined = tail + content;
      const leaked = containsDsmlProtocolLeak(combined);
      tail = combined.slice(-DETECTOR_TAIL_LENGTH);
      return leaked;
    },
    hasPendingMarker() {
      const lowerTail = tail.toLowerCase();
      return DSML_MARKER_PREFIXES.some((marker) => {
        const maxPrefixLength = Math.min(marker.length - 1, lowerTail.length);
        for (let length = maxPrefixLength; length > 0; length--) {
          if (lowerTail.endsWith(marker.slice(0, length))) return true;
        }
        return false;
      });
    },
  };
}

function replayResponse(response, bufferedChunks, reader) {
  let bufferedIndex = 0;
  // Pull on demand so the short preflight does not drain a long upstream stream.
  const body = new ReadableStream({
    async pull(controller) {
      if (bufferedIndex < bufferedChunks.length) {
        controller.enqueue(bufferedChunks[bufferedIndex]);
        bufferedIndex += 1;
        return;
      }
      try {
        const { done, value } = await reader.read();
        if (done) controller.close();
        else controller.enqueue(value);
      } catch (error) {
        controller.error(error);
      }
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });

  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

function inspectSseLine(line, detector) {
  const trimmed = line.trim();
  if (!trimmed.startsWith("data:")) return { semantic: false, leaked: false };
  const data = trimmed.slice(5).trim();
  if (!data || data === "[DONE]") return { semantic: data === "[DONE]", leaked: false };

  let parsed;
  try {
    parsed = JSON.parse(data);
  } catch {
    return { semantic: false, leaked: false };
  }

  let semantic = false;
  for (const choice of parsed?.choices || []) {
    const delta = choice?.delta || {};
    if (typeof delta.content === "string" && delta.content.length > 0) {
      semantic = true;
      if (detector.push(delta.content)) return { semantic: true, leaked: true, pending: false };
    }
    if (Array.isArray(delta.tool_calls) && delta.tool_calls.length > 0) semantic = true;
    if (choice?.finish_reason) semantic = true;
  }
  return { semantic, leaked: false, pending: detector.hasPendingMarker() };
}

export async function preflightDsmlResponse(response, { body, model } = {}) {
  if (!shouldGuardDsml(body, model) || !response?.body) return response;
  const contentType = response.headers?.get?.("content-type") || "";
  if (!contentType.toLowerCase().includes("text/event-stream")) return response;

  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: false });
  const detector = createDsmlLeakDetector();
  const chunks = [];
  let bufferedText = "";
  let bufferedBytes = 0;
  let semantic = false;

  try {
    while (!semantic && bufferedBytes < PREFLIGHT_BYTE_LIMIT) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      bufferedBytes += value.byteLength;
      bufferedText += decoder.decode(value, { stream: true });

      const lines = bufferedText.split("\n");
      bufferedText = lines.pop() || "";
      for (const line of lines) {
        const inspected = inspectSseLine(line, detector);
        if (inspected.leaked) throw new DsmlProtocolError();
        // Keep buffering when a protocol marker may continue in the next delta.
        semantic ||= inspected.semantic && !inspected.pending;
      }
    }
  } catch (error) {
    await reader.cancel(error).catch(() => {});
    throw error;
  }

  return replayResponse(response, chunks, reader);
}
