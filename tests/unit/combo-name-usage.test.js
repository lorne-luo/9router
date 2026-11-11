// A request made through a combo carries the combo name down to chatCore
// (via clientRawRequest) so usage records can show which combo was called.
import { describe, it, expect, vi, beforeEach } from "vitest";

const fx = vi.hoisted(() => ({
  combos: [{ id: "c1", name: "Main", models: ["openai/model-a", "openai/model-b"] }],
}));
const mocks = vi.hoisted(() => ({
  getProviderCredentials: vi.fn(),
  handleChatCore: vi.fn(),
  saveRequestUsage: vi.fn(async () => {}),
}));

vi.mock("@/lib/localDb", () => ({
  getSettings: async () => ({ requireApiKey: false, comboStrategy: "fallback" }),
  getModelAliases: async () => ({}),
  getComboByName: async (name) => fx.combos.find((c) => c.name === name) || null,
  getProviderNodes: async () => [],
  getCombos: async () => fx.combos,
  getProviderConnections: async () => [],
  getProviderConnectionById: async () => null,
  getCustomModels: async () => [],
}));
vi.mock("@/lib/disabledModelsDb", () => ({ getDisabledModels: async () => ({}) }));
vi.mock("@/lib/db/repos/combosRepo.js", () => ({ getCombos: async () => fx.combos }));
vi.mock("@/lib/db/repos/apiKeysRepo.js", () => ({ getApiKeyByKey: async () => null }));
vi.mock("@/lib/usageDb.js", () => ({
  saveRequestUsage: mocks.saveRequestUsage,
  appendRequestLog: vi.fn(async () => {}),
  saveRequestDetail: vi.fn(async () => {}),
}));
vi.mock("@/sse/services/auth.js", () => ({
  getProviderCredentials: mocks.getProviderCredentials,
  markAccountUnavailable: vi.fn(async () => ({ shouldFallback: false })),
  clearAccountError: vi.fn(),
  extractApiKey: () => null,
  isValidApiKey: async () => true,
}));
vi.mock("@/sse/services/tokenRefresh.js", () => ({
  checkAndRefreshToken: async (_p, c) => c,
  updateProviderCredentials: vi.fn(),
}));
vi.mock("open-sse/handlers/chatCore.js", () => ({ handleChatCore: mocks.handleChatCore }));

const { handleChat } = await import("../../src/sse/handlers/chat.js");
const { saveUsageStats } = await import("../../open-sse/handlers/chatCore/requestDetail.js");

const enc = new TextEncoder();
const sse = (frames) => new Response(new ReadableStream({
  start(c) { for (const f of frames) c.enqueue(enc.encode(f)); c.close(); },
}), { status: 200, headers: { "Content-Type": "text/event-stream" } });
const OK = [
  `data: {"id":"x","choices":[{"index":0,"delta":{"content":"hi"},"finish_reason":null}]}\n\n`,
  `data: [DONE]\n\n`,
];

const chat = (model) => handleChat(new Request("http://localhost/v1/chat/completions", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ model, stream: true, messages: [{ role: "user", content: "hi" }] }),
}));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getProviderCredentials.mockResolvedValue({ connectionId: "conn", connectionName: "mock" });
  // model-a fails so the combo has to fail over to model-b.
  mocks.handleChatCore.mockImplementation(async ({ modelInfo }) => (modelInfo.model === "model-a"
    ? {
      success: false, status: 500, error: "upstream error",
      response: new Response(JSON.stringify({ error: { message: "upstream error" } }), { status: 500, headers: { "Content-Type": "application/json" } }),
    }
    : { success: true, response: sse(OK) }));
});

describe("combo name on usage records", () => {
  it("every member call of a combo carries the combo name", async () => {
    expect((await chat("Main")).status).toBe(200);
    const calls = mocks.handleChatCore.mock.calls.map(([a]) => [a.modelInfo.model, a.clientRawRequest?.comboName]);
    expect(calls).toEqual([["model-a", "Main"], ["model-b", "Main"]]);
  });

  it("a direct model call has no combo name", async () => {
    expect((await chat("openai/model-b")).status).toBe(200);
    expect(mocks.handleChatCore.mock.calls[0][0].clientRawRequest?.comboName).toBeUndefined();
  });

  it("saveUsageStats forwards the combo name to saveRequestUsage", () => {
    saveUsageStats({ provider: "openai", model: "model-b", tokens: { prompt_tokens: 3, completion_tokens: 1 }, comboName: "Main", silent: true });
    expect(mocks.saveRequestUsage).toHaveBeenCalledWith(expect.objectContaining({ comboName: "Main" }));
  });
});
