import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const originalDataDir = process.env.DATA_DIR;
let tempDir;
let renameModelAliasPrefix, getModelAliases, setModelAlias;

beforeEach(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-alias-rename-"));
  process.env.DATA_DIR = tempDir;
  // Reset modules AND the cached adapter (driver.js caches it on globalThis,
  // which vi.resetModules() does not clear) so each test gets a fresh DB.
  vi.resetModules();
  global._dbAdapter = null;
  const db = await import("@/lib/db/index.js");
  await db.initDb();
  const repo = await import("@/lib/db/repos/aliasRepo.js");
  renameModelAliasPrefix = repo.renameModelAliasPrefix;
  getModelAliases = repo.getModelAliases;
  setModelAlias = repo.setModelAlias;
});

afterEach(() => {
  if (tempDir && fs.existsSync(tempDir)) {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
  process.env.DATA_DIR = originalDataDir;
});

describe("renameModelAliasPrefix", () => {
  // Aliases are stored as { aliasName: "provider/model" }; the provider prefix
  // lives in the value, keyed by an arbitrary user-chosen alias name.
  it("rewrites every alias value pointing at the old prefix", async () => {
    await setModelAlias("fast", "xiaomi/mimo-v2.5");
    await setModelAlias("smart", "xiaomi/mimo-pro");
    await setModelAlias("gpt", "openai/gpt-4");

    const result = await renameModelAliasPrefix("xiaomi", "xiaomi2");

    expect(result).toEqual({ migrated: 2 });
    const aliases = await getModelAliases();
    expect(aliases).toEqual({
      fast: "xiaomi2/mimo-v2.5",
      smart: "xiaomi2/mimo-pro",
      gpt: "openai/gpt-4",
    });
  });

  it("leaves the alias name (key) untouched", async () => {
    // An alias whose NAME happens to equal the prefix must not be renamed.
    await setModelAlias("xiaomi", "openai/gpt-4");

    const result = await renameModelAliasPrefix("xiaomi", "xiaomi2");

    expect(result).toEqual({ migrated: 0 });
    const aliases = await getModelAliases();
    expect(aliases).toEqual({ xiaomi: "openai/gpt-4" });
  });

  it("does not touch a prefix that is only a substring of another provider", async () => {
    await setModelAlias("a", "xiaomixyz/model");
    await setModelAlias("b", "mimo/model");

    const result = await renameModelAliasPrefix("xiaomi", "xiaomi2");

    expect(result).toEqual({ migrated: 0 });
    const aliases = await getModelAliases();
    expect(aliases).toEqual({ a: "xiaomixyz/model", b: "mimo/model" });
  });

  it("returns zero when oldPrefix === newPrefix", async () => {
    const result = await renameModelAliasPrefix("xiaomi", "xiaomi");
    expect(result).toEqual({ migrated: 0 });
  });
});
