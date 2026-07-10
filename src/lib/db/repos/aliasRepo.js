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

// When a provider node's prefix changes, rewrite every model alias that points
// at the old prefix so it points at the new one. Aliases are stored as
// { aliasName: "provider/model" } — the provider prefix lives in the *value*'s
// leading segment (before the first "/"), not in the key. Only values of the
// exact form `${oldPrefix}/...` are migrated; the alias name (key) is untouched.
// Returns { migrated }.
export async function renameModelAliasPrefix(oldPrefix, newPrefix) {
  if (!oldPrefix || !newPrefix || oldPrefix === newPrefix) {
    return { migrated: 0 };
  }
  const all = await aliasKv.getAll();
  const db = await getAdapter();
  const updates = [];
  for (const [key, value] of Object.entries(all)) {
    if (typeof value === "string" && value.startsWith(`${oldPrefix}/`)) {
      const newValue = `${newPrefix}/${value.slice(oldPrefix.length + 1)}`;
      updates.push({ key, newValue });
    }
  }
  db.transaction(() => {
    for (const { key, newValue } of updates) {
      db.run(
        `UPDATE kv SET value = ? WHERE scope = 'modelAliases' AND key = ?`,
        [stringifyJson(newValue), key]
      );
    }
  });
  return { migrated: updates.length };
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
