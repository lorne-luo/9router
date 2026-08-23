# DeepSeek DSML Stream Guard Design

## Problem

DeepSeek V4 can emit its native DSML tool protocol as ordinary OpenAI
`delta.content` when the upstream serving adapter fails to recognize a malformed
or missing DSML start marker. In a combo route, 9router currently treats the
upstream HTTP 2xx as success before validating the streamed payload, so the
broken stream cannot fall back. QwenPaw then displays the leaked protocol as
plain text because it only recovers `<tool_call>` blocks.

## Scope

The guard applies only when all of these conditions hold:

- the request includes tool definitions;
- the candidate model is a DeepSeek V4 family model;
- the response is an OpenAI-compatible SSE stream.

Ordinary text requests and other model families remain unchanged.

## 9router Design

Add a focused DSML detector and an initial SSE preflight at the combo boundary.
The preflight reads through non-semantic metadata/reasoning events until the
first assistant content or structured tool-call delta. Buffered bytes are
replayed unchanged on success. A structured OpenAI tool call or ordinary text
is healthy; DSML markers in `delta.content` are a provider protocol failure.
The failed response body is cancelled and the combo loop continues with its
next candidate.

The normal OpenAI passthrough stream also uses the detector as defense in depth.
If DSML appears after preflight has released the stream, the transform aborts
with a concise protocol error rather than forwarding an unbounded tag flood.
Late detection cannot transparently retry because response bytes may already
have reached the client.

The implementation will not convert DSML into executable tool calls. Guessing
at malformed protocol could execute the wrong tool or arguments.

## QwenPaw Design

Extend the local model compatibility boundary with DSML leak detection. When a
provider returns DSML inside an assistant text or thinking block, reject the
response with a concise provider-protocol exception before any recovered tool
call is executed. The detector handles canonical full-width DSML markers and
the malformed plain `<invoke>`/`</invoke>` variants observed in the incident.

QwenPaw remains a secondary guard: routing fallback belongs in 9router, while
QwenPaw prevents direct or differently-routed providers from flooding a chat.

## Error Handling

- 9router preflight violation: cancel candidate stream, log the protocol error,
  and continue combo fallback.
- 9router late violation: abort the outgoing transform with a named protocol
  error.
- QwenPaw violation: raise a named compatibility error; do not create tool-call
  blocks from DSML text.

No raw prompts, credentials, or leaked output are added to logs.

## Tests

9router tests cover healthy text replay, structured tool-call replay, malformed
DSML fallback, split-marker detection, and non-DeepSeek/non-tool bypass.
QwenPaw tests cover canonical DSML, malformed invoke tags, normal prose that
mentions the word "invoke", and refusal to recover leaked DSML as a tool call.

