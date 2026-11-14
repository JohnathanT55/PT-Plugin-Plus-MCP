#!/usr/bin/env node

/**
 * Safe, read-only regression runner for a live PTPP MCP bridge.
 *
 * Usage (from the MCP repository):
 *   node --env-file-if-exists=.env scripts/mcp-live-regression.mjs --session-index=0
 *
 * The session index is intentionally mandatory. A session is selected only
 * after listing all sessions and sorting by openedAt; this prevents a stale
 * or unrelated browser profile from being selected accidentally. The runner
 * never prints session IDs, extension IDs, site IDs, titles, URLs, paths, or
 * response bodies. It also never calls a write, sign-in, download, restore,
 * cleanup, refresh, or LLM capability.
 *
 * --skip-remote omits backup connection/listing checks. This is useful when a
 * disposable remote backup is unavailable, but is not equivalent to a full
 * read-only regression. --report=<path> writes only aggregate pass/fail/skip
 * counts and case labels; no identifiers or business data are written.
 */

const DEFAULT_PORT = 19799;
const timeoutMs = 55_000;
const settingsGroups = [
  "interface",
  "toolbar",
  "browser",
  "userData",
  "search",
  "movies",
  "download",
  "backup",
  "signIn",
  "mcp",
];
const pages = [
  "search",
  "my-data",
  "snapshot",
  "download-history",
  "collection",
  "reseed",
  "downloaders",
  "settings-downloader",
  "settings-base",
  "settings-site",
  "settings-download-paths",
  "settings-search-solution",
  "settings-backup",
  "about",
  "timeline",
  "statistic",
  "link-push",
];

function arg(name) {
  const prefix = `--${name}=`;
  const value = process.argv.find((item) => item.startsWith(prefix));
  return value === undefined ? undefined : value.slice(prefix.length);
}

function fail(message) {
  console.error(`Usage error: ${message}`);
  process.exitCode = 2;
  throw new Error(message);
}

const sessionIndexText = arg("session-index");
if (sessionIndexText === undefined || !/^\d+$/.test(sessionIndexText))
  fail("--session-index=N is required");
const sessionIndex = Number(sessionIndexText);
if (!Number.isSafeInteger(sessionIndex)) fail("session index is out of range");
const skipRemote = process.argv.includes("--skip-remote");
const reportPath = arg("report");
const port = Number(process.env.PTPP_MCP_BRIDGE_PORT ?? DEFAULT_PORT);
const token = process.env.PTPP_MCP_BRIDGE_TOKEN?.trim();
if (!token) fail("PTPP_MCP_BRIDGE_TOKEN is not set");
if (!Number.isInteger(port) || port < 1 || port > 65535)
  fail("PTPP_MCP_BRIDGE_PORT is invalid");

const base = `http://127.0.0.1:${port}`;
const headers = {
  Authorization: `Bearer ${token}`,
  "Content-Type": "application/json",
};
const results = [];

function safeCode(value) {
  if (!value || typeof value !== "object") return "unknown";
  const code = value.error?.code ?? value.code ?? value.error;
  return typeof code === "string"
    ? code.slice(0, 80).replace(/[^a-zA-Z0-9_.-]/g, "_")
    : "unknown";
}

async function http(path, body) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${base}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers:
        body === undefined ? { Authorization: headers.Authorization } : headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: controller.signal,
    });
    let parsed;
    try {
      parsed = await response.json();
    } catch {
      parsed = {};
    }
    return { status: response.status, body: parsed };
  } finally {
    clearTimeout(timer);
  }
}

async function call(sessionId, capability, input = {}) {
  const response = await http(
    `/v1/session/${encodeURIComponent(sessionId)}/request`,
    { capability, input },
  );
  if (!response.body || response.body.ok !== true) {
    const error = new Error(safeCode(response.body));
    error.code = safeCode(response.body);
    error.httpStatus = response.status;
    throw error;
  }
  return response.body.result;
}

function record(label, state, detail) {
  results.push({ label, state, ...(detail ? { detail } : {}) });
  const suffix = detail ? ` (${detail})` : "";
  console.log(`${state.padEnd(4)} ${label}${suffix}`);
}

async function check(label, operation, { optional = false } = {}) {
  try {
    const value = await operation();
    record(label, "PASS");
    return value;
  } catch (error) {
    const code = error?.code ?? "runtime_error";
    record(label, optional ? "SKIP" : "FAIL", code);
    return undefined;
  }
}

function isObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
function assertObject(value, label) {
  if (!isObject(value))
    throw Object.assign(new Error(label), { code: "invalid_shape" });
}
function assertPage(value) {
  assertObject(value, "page_context shape");
  if (typeof value.available !== "boolean")
    throw Object.assign(new Error("page_context availability"), {
      code: "invalid_shape",
    });
}
function firstItem(value) {
  return isObject(value) && Array.isArray(value.items)
    ? value.items[0]
    : undefined;
}
function firstId(value, keys) {
  const item = firstItem(value);
  if (!isObject(item)) return undefined;
  for (const key of keys)
    if (typeof item[key] === "string" && item[key]) return item[key];
  return undefined;
}

const health = await http("/health").catch((error) =>
  fail(`bridge unavailable: ${error.name ?? "connection"}`),
);
if (health.status !== 200 || health.body?.ok !== true)
  fail("bridge health check failed");
const sessionsResponse = await http("/v1/sessions");
if (
  sessionsResponse.status !== 200 ||
  !Array.isArray(sessionsResponse.body?.sessions)
)
  fail("session discovery failed");
const sessions = [...sessionsResponse.body.sessions].sort(
  (a, b) => Number(a.openedAt) - Number(b.openedAt),
);
if (sessionIndex >= sessions.length)
  fail(`session index out of range (available=${sessions.length})`);
const session = sessions[sessionIndex];
if (
  !session ||
  typeof session.sessionId !== "string" ||
  !Array.isArray(session.capabilities)
)
  fail("selected session is invalid");
const capabilities = new Set(
  session.capabilities
    .map((item) => item?.id)
    .filter((item) => typeof item === "string"),
);
const has = (capability) => capabilities.has(capability);

async function query(label, capability, input = {}, options) {
  if (!has(capability)) {
    record(label, "SKIP", "capability_unregistered");
    return undefined;
  }
  return check(
    label,
    async () => {
      const result = await call(session.sessionId, capability, input);
      assertObject(result, `${capability} result`);
      return result;
    },
    options,
  );
}

await query("extension_info", "ptpp.extension_info");
await query("routes", "ptpp.ui.routes");
for (const page of pages)
  await query(
    `page_context:${page}`,
    "ptpp.page_context",
    { page, maxItems: 5 },
    { optional: true },
  );

const sites = await query("sites_list", "ptpp.sites.list", {
  offset: 0,
  limit: 100,
});
const userData = await query("user_data_get", "ptpp.user_data.get", {
  offset: 0,
  limit: 100,
});
const firstSiteId = firstId(sites, ["id", "siteId"]);
if (firstSiteId && has("ptpp.user_data.history"))
  await query("user_data_history", "ptpp.user_data.history", {
    siteId: firstSiteId,
    offset: 0,
    limit: 10,
  });
await query("user_data_timeline", "ptpp.user_data.timeline", {
  offset: 0,
  limit: 10,
});
await query("user_data_statistic", "ptpp.user_data.statistic");

const downloaders = await query("downloaders_list", "ptpp.downloaders.list", {
  offset: 0,
  limit: 100,
});
const firstDownloaderId = firstId(downloaders, ["id", "downloaderId"]);
if (firstDownloaderId) {
  await query(
    "downloader_status",
    "ptpp.downloaders.status",
    { downloaderId: firstDownloaderId },
    { optional: true },
  );
  await query(
    "downloader_config_form",
    "ptpp.downloader_configs.form",
    {},
    { optional: true },
  );
  if (has("ptpp.downloader_configs.test"))
    await query(
      "downloader_connection_test",
      "ptpp.downloader_configs.test",
      { downloaderId: firstDownloaderId },
      { optional: true },
    );
}

await query(
  "collections_list",
  "ptpp.collections.list",
  { offset: 0, limit: 25 },
  { optional: true },
);
await query(
  "download_history_list",
  "ptpp.download_history.list",
  { offset: 0, limit: 25 },
  { optional: true },
);
await query(
  "reseed_list",
  "ptpp.reseed.list",
  { offset: 0, limit: 25 },
  { optional: true },
);
await query(
  "snapshots_list",
  "ptpp.snapshots.list",
  { offset: 0, limit: 25 },
  { optional: true },
);
await query(
  "operations_list",
  "ptpp.operations.list",
  { offset: 0, limit: 25 },
  { optional: true },
);
await query(
  "operations_pending",
  "ptpp.operations.pending",
  { offset: 0, limit: 25 },
  { optional: true },
);
await query("browser_tabs", "ptpp.browser.tabs", {}, { optional: true });

const backupServers = await query(
  "backups_list",
  "ptpp.backups.list",
  { offset: 0, limit: 100 },
  { optional: skipRemote },
);
const backupServerId = firstId(backupServers, ["id", "backupServerId"]);
if (backupServerId && !skipRemote) {
  await query("backup_history", "ptpp.backups.history", {
    backupServerId,
    offset: 0,
    limit: 25,
  });
  await query("backup_files", "ptpp.backups.files", {
    backupServerId,
    offset: 0,
    limit: 25,
  });
  await query("backup_cleanup_preview", "ptpp.backups.cleanup_preview", {
    backupServerId,
  });
  await query(
    "backup_connection_test",
    "ptpp.backup_servers.test",
    { backupServerId },
    { optional: true },
  );
}

for (const group of settingsGroups)
  await query(
    `settings_form:${group}`,
    "ptpp.settings.form",
    { group },
    { optional: true },
  );
await query("search_plans", "ptpp.search.plans", {});
await query("settings_get", "ptpp.settings.get", {}, { optional: true });

const summary = {
  protocol: health.body.protocol,
  sessionIndex,
  capabilityCount: capabilities.size,
  pass: results.filter((item) => item.state === "PASS").length,
  fail: results.filter((item) => item.state === "FAIL").length,
  skip: results.filter((item) => item.state === "SKIP").length,
  remoteChecks: !skipRemote,
};
console.log(JSON.stringify(summary));
if (reportPath) {
  const fs = await import("node:fs/promises");
  await fs.writeFile(
    reportPath,
    `${JSON.stringify({ ...summary, cases: results.map(({ label, state, detail }) => ({ label, state, ...(detail ? { detail } : {}) })) }, null, 2)}\n`,
    "utf8",
  );
}
if (summary.fail > 0) process.exitCode = 1;
