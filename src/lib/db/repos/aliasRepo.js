import { getAdapter } from "../driver.js";
import { parseJson, stringifyJson } from "../helpers/jsonCol.js";
import { makeKv } from "../helpers/kvStore.js";

const aliasKv = makeKv("modelAliases");
const customKv = makeKv("customModels");
const mitmKv = makeKv("mitmAlias");

// modelAliases: key=alias, value=modelString
export async function getModelAliases() {
  return await aliasKv.getAll();
}

export async function setModelAlias(alias, model) {
  await aliasKv.set(alias, model);
}

export async function deleteModelAlias(alias) {
  await aliasKv.remove(alias);
}

// Rename all modelAliases keys matching `oldPrefix` or `oldPrefix-*` to the
// equivalent `newPrefix` / `newPrefix-*` keys. Conflict-safe: if a target key
// already exists, the source is left untouched and reported in `conflicts`.
// Returns { renamed, skipped, conflicts }.
export async function renameModelAliasPrefix(oldPrefix, newPrefix) {
  if (!oldPrefix || !newPrefix || oldPrefix === newPrefix) {
    return { renamed: 0, skipped: 0, conflicts: [] };
  }
  const all = await aliasKv.getAll();
  const db = await getAdapter();
  const pairs = [];
  for (const key of Object.keys(all)) {
    if (key === oldPrefix || key.startsWith(`${oldPrefix}-`)) {
      const suffix = key.slice(oldPrefix.length); // "" or "-mimo-v2.5"
      pairs.push({ oldKey: key, newKey: `${newPrefix}${suffix}`, value: all[key] });
    }
  }
  const conflicts = [];
  const renamed = [];
  db.transaction(() => {
    const existing = new Set(
      db.all(`SELECT key FROM kv WHERE scope = 'modelAliases'`).map((r) => r.key)
    );
    for (const { oldKey, newKey, value } of pairs) {
      if (existing.has(newKey)) {
        conflicts.push({ oldKey, newKey });
        continue;
      }
      db.run(`DELETE FROM kv WHERE scope = 'modelAliases' AND key = ?`, [oldKey]);
      db.run(
        `INSERT INTO kv(scope, key, value) VALUES('modelAliases', ?, ?)`,
        [newKey, stringifyJson(value)]
      );
      renamed.push({ oldKey, newKey });
    }
  });
  return { renamed: renamed.length, skipped: conflicts.length, conflicts };
}

// customModels: key=`${providerAlias}|${id}|${type}`, value=full model object
function customKey(providerAlias, id, type) {
  return `${providerAlias}|${id}|${type}`;
}

export async function getCustomModels() {
  const all = await customKv.getAll();
  return Object.values(all);
}

// Atomic check-then-insert inside transaction to prevent duplicate races
export async function addCustomModel({ providerAlias, id, type = "llm", name }) {
  const k = customKey(providerAlias, id, type);
  const db = await getAdapter();
  let added = false;
  db.transaction(() => {
    const row = db.get(`SELECT 1 FROM kv WHERE scope = 'customModels' AND key = ?`, [k]);
    if (row) return;
    const value = stringifyJson({ providerAlias, id, type, name: name || id });
    db.run(`INSERT INTO kv(scope, key, value) VALUES('customModels', ?, ?)`, [k, value]);
    added = true;
  });
  return added;
}

export async function deleteCustomModel({ providerAlias, id, type = "llm" }) {
  await customKv.remove(customKey(providerAlias, id, type));
}

// mitmAlias: key=toolName, value=mappings object
export async function getMitmAlias(toolName) {
  if (toolName) {
    const v = await mitmKv.get(toolName);
    return v || {};
  }
  return await mitmKv.getAll();
}

export async function setMitmAliasAll(toolName, mappings) {
  await mitmKv.set(toolName, mappings || {});
}
