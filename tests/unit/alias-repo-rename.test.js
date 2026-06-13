import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const originalDataDir = process.env.DATA_DIR;
let tempDir;
let renameModelAliasPrefix, getModelAliases;

beforeEach(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-alias-rename-"));
  process.env.DATA_DIR = tempDir;
  // Reset modules to get fresh db instance
  vi.resetModules();
  const db = await import("@/lib/db/index.js");
  await db.initDb();
  const repo = await import("@/lib/db/repos/aliasRepo.js");
  renameModelAliasPrefix = repo.renameModelAliasPrefix;
  getModelAliases = repo.getModelAliases;
});

afterEach(() => {
  if (tempDir && fs.existsSync(tempDir)) {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
  process.env.DATA_DIR = originalDataDir;
});

describe("renameModelAliasPrefix", () => {
  it("renames all matching prefix-* keys to new prefix", async () => {
    const db = await import("@/lib/db/index.js").then(m => m.default);
    await db.run(`INSERT INTO kv(scope, key, value) VALUES('modelAliases', 'xiaomi-foo', '"v1"')`);
    await db.run(`INSERT INTO kv(scope, key, value) VALUES('modelAliases', 'xiaomi-bar', '"v2"')`);
    await db.run(`INSERT INTO kv(scope, key, value) VALUES('modelAliases', 'other-baz', '"v3"')`);

    const result = await renameModelAliasPrefix("xiaomi", "xiaomi2");

    expect(result).toEqual({ renamed: 2, skipped: 0, conflicts: [] });
    const aliases = await getModelAliases();
    expect(aliases).toEqual({
      "xiaomi2-foo": "v1",
      "xiaomi2-bar": "v2",
      "other-baz": "v3",
    });
  });

  it("skips rename when target key already exists", async () => {
    const db = await import("@/lib/db/index.js").then(m => m.default);
    await db.run(`INSERT INTO kv(scope, key, value) VALUES('modelAliases', 'xiaomi-foo', '"v1"')`);
    await db.run(`INSERT INTO kv(scope, key, value) VALUES('modelAliases', 'xiaomi2-foo', '"v2"')`);

    const result = await renameModelAliasPrefix("xiaomi", "xiaomi2");

    expect(result).toEqual({
      renamed: 0,
      skipped: 1,
      conflicts: [{ oldKey: "xiaomi-foo", newKey: "xiaomi2-foo" }],
    });
    const aliases = await getModelAliases();
    expect(aliases).toEqual({
      "xiaomi-foo": "v1",
      "xiaomi2-foo": "v2",
    });
  });

  it("handles bare prefix key (no dash)", async () => {
    const db = await import("@/lib/db/index.js").then(m => m.default);
    await db.run(`INSERT INTO kv(scope, key, value) VALUES('modelAliases', 'xiaomi', '"v1"')`);

    const result = await renameModelAliasPrefix("xiaomi", "xiaomi2");

    expect(result).toEqual({ renamed: 1, skipped: 0, conflicts: [] });
    const aliases = await getModelAliases();
    expect(aliases).toEqual({ "xiaomi2": "v1" });
  });

  it("returns zero when oldPrefix === newPrefix", async () => {
    const result = await renameModelAliasPrefix("xiaomi", "xiaomi");
    expect(result).toEqual({ renamed: 0, skipped: 0, conflicts: [] });
  });

  it("does not touch unrelated keys", async () => {
    const db = await import("@/lib/db/index.js").then(m => m.default);
    await db.run(`INSERT INTO kv(scope, key, value) VALUES('modelAliases', 'other-key', '"v1"')`);
    await db.run(`INSERT INTO kv(scope, key, value) VALUES('modelAliases', 'mimoc-key', '"v2"')`);

    const result = await renameModelAliasPrefix("xiaomi", "xiaomi2");

    expect(result).toEqual({ renamed: 0, skipped: 0, conflicts: [] });
    const aliases = await getModelAliases();
    expect(aliases).toEqual({
      "other-key": "v1",
      "mimoc-key": "v2",
    });
  });
});
