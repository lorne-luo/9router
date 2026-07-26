import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

let tempDir;
let db;
let adapter;
beforeEach(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-observability-"));
  vi.stubEnv("DATA_DIR", tempDir);
  vi.stubEnv("ENABLE_REQUEST_LOGS", undefined);
  vi.resetModules();
  global._dbAdapter = null;
  db = await import("@/lib/db/index.js");
  await db.initDb();
  adapter = global._dbAdapter;
});
afterEach(() => {
  adapter?.close?.();
  global._dbAdapter = null;
  vi.unstubAllEnvs();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

it.each([
  ["true", false, true],
  ["TRUE", false, true],
  ["false", true, false],
  [undefined, true, true],
  [undefined, false, false],
])("env %s overrides UI %s: persisted=%s", async (env, ui, enabled) => {
  vi.stubEnv("ENABLE_REQUEST_LOGS", env);
  await db.updateSettings({ enableObservability: ui, observabilityBatchSize: 1 });
  await db.saveRequestDetail({ id: "config-test", model: "test" });
  if (enabled) {
    await vi.waitFor(async () => {
      expect(await db.getRequestDetailById("config-test")).toBeTruthy();
    });
  } else {
    expect(await db.getRequestDetailById("config-test")).toBeNull();
  }
});
