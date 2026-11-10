// Recent Requests on /dashboard/usage must show failed requests (with provider
// and status code) alongside successful ones, and more than the old 20 rows.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

let tempDir;
const originalDataDir = process.env.DATA_DIR;

async function loadRepo() {
  return import("@/lib/db/repos/usageRepo.js");
}

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-recent-"));
  process.env.DATA_DIR = tempDir;
  delete global._dbAdapter;
  delete global._recentRing;
  vi.resetModules();
});

afterEach(() => {
  try { global._dbAdapter?.instance?.close?.(); } catch {}
  delete global._dbAdapter;
  delete global._recentRing;
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

function okEntry(i) {
  return {
    provider: "openai",
    model: `gpt-${i}`,
    tokens: { prompt_tokens: 10 + i, completion_tokens: 5 },
    timestamp: new Date(Date.now() - (100 - i) * 1000).toISOString(),
  };
}

describe("recent requests", () => {
  it("includes failed requests with provider and status code", async () => {
    const repo = await loadRepo();
    await repo.saveRequestUsage(okEntry(1));
    await repo.appendRequestLog({ model: "claude-x", provider: "claude", connectionId: "c1", status: "FAILED 429" });

    const { recentRequests } = await repo.getActiveRequests();
    expect(recentRequests).toHaveLength(2);
    expect(recentRequests[0]).toMatchObject({ model: "claude-x", provider: "claude", status: "error", statusCode: 429 });
    expect(recentRequests[1]).toMatchObject({ model: "gpt-1", provider: "openai", status: "ok" });
  });

  it("ignores non-failure log statuses", async () => {
    const repo = await loadRepo();
    await repo.appendRequestLog({ model: "m", provider: "p", status: "PENDING" });
    await repo.appendRequestLog({ model: "m", provider: "p", status: "200 OK" });

    const { recentRequests } = await repo.getActiveRequests();
    expect(recentRequests).toHaveLength(0);
  });

  it("returns more than 20 requests", async () => {
    const repo = await loadRepo();
    for (let i = 0; i < 30; i++) await repo.saveRequestUsage(okEntry(i));

    const { recentRequests } = await repo.getActiveRequests();
    expect(recentRequests).toHaveLength(30);
  });

  it("getUsageStats returns the same list including failures", async () => {
    const repo = await loadRepo();
    await repo.saveRequestUsage(okEntry(1));
    await repo.appendRequestLog({ model: "gemini-y", provider: "gemini", status: "FAILED 502" });

    const stats = await repo.getUsageStats();
    expect(stats.recentRequests.map((r) => r.status)).toEqual(["error", "ok"]);
    expect(stats.recentRequests[0]).toMatchObject({ provider: "gemini", statusCode: 502 });
  });

  it("restores failures from requestDetails after restart", async () => {
    const repo = await loadRepo();
    const { getAdapter } = await import("@/lib/db/driver.js");
    const db = await getAdapter();
    const ts = new Date().toISOString();
    db.run(
      `INSERT INTO requestDetails(id, timestamp, provider, model, connectionId, status, data) VALUES(?, ?, ?, ?, ?, ?, ?)`,
      ["d1", ts, "kiro", "kiro-model", null, "error", JSON.stringify({ response: { status: 503 } })],
    );

    const { recentRequests } = await repo.getActiveRequests();
    expect(recentRequests).toHaveLength(1);
    expect(recentRequests[0]).toMatchObject({ provider: "kiro", model: "kiro-model", status: "error", statusCode: 503 });
  });
});
