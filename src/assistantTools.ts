import type { AiAssistRequest, CapabilityDescriptor } from "./protocol.js";
import { selectSession, type CapabilityBridge } from "./mcp.js";

const READ_CAPABILITIES = new Set([
  "ptpp.sites.list", "ptpp.user_data.get", "ptpp.downloaders.list", "ptpp.downloaders.status",
  "ptpp.search.status", "ptpp.search.results", "ptpp.signin.status", "ptpp.backups.list", "ptpp.backups.history",
]);

export interface AiTool {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
}
export interface AiTools {
  tools: AiTool[];
  execute(name: string, input: unknown): Promise<unknown>;
  fallbackContext(): Promise<unknown>;
}

export function explicitSearchRequested(request: AiAssistRequest): boolean {
  if (request.mode !== "assist") return false;
  const prompt = request.prompt ?? "";
  if (/(不要|无需|别|不用).{0,8}(搜索|查找|搜一下)|\b(?:do not|don't|without)\s+search/i.test(prompt)) return false;
  return /搜索|搜一下|搜一搜|帮.{0,8}找|查找|\bsearch\b|\bfind\b/i.test(prompt);
}

const secretKey = /^(?:cookie|cookies|passkey|password|passwd|token|secret|authorization|api[_-]?key|username|userName|userId|email|address|url|baseUrl|host|hostname|headers)$/i;

/** Preserve business fields, including all requirements/unmet values. */
export function protectToolResult(value: unknown, depth = 0): unknown {
  if (depth > 16) return undefined;
  if (typeof value === "string") return value.replace(/https?:\/\/[^\s<>"']+/gi, "[link omitted]").replace(/\b(?:sk-[A-Za-z0-9_-]{16,}|(?:Bearer\s+)[A-Za-z0-9._-]{8,})/gi, "[credential omitted]");
  if (Array.isArray(value)) return value.map((item) => protectToolResult(item, depth + 1));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).filter(([key]) => !secretKey.test(key)).map(([key, item]) => [key, protectToolResult(item, depth + 1)]));
  return value;
}

export async function createAssistantTools(bridge: CapabilityBridge, request: AiAssistRequest, sessionId?: string): Promise<AiTools | undefined> {
  if (request.mode === "test" || request.mode === "search-draft") return undefined;
  const session = await selectSession(bridge, sessionId);
  const allowed = session.capabilities.filter((item) => item.confirmation === "none" &&
    (READ_CAPABILITIES.has(item.id) || (item.id === "ptpp.search.start" && explicitSearchRequested(request))));
  const byName = new Map(allowed.map((item) => [item.id.replace(/\./g, "__"), item]));
  const run = async (descriptor: CapabilityDescriptor, input: unknown) => {
    const result = await bridge.enqueueToolRequest(session.sessionId, { capability: descriptor.id, input });
    return protectToolResult(result);
  };
  return {
    tools: [...byName].map(([name, descriptor]) => ({ type: "function", function: {
      name,
      description: descriptor.description,
      parameters: descriptor.inputSchema?.type ? descriptor.inputSchema : { type: "object", properties: {} },
    } })),
    execute: async (name, input) => {
      const descriptor = byName.get(name);
      if (!descriptor) return { ok: false, error: { code: "unsupported_tool", message: "This operation is not permitted in this conversation" } };
      if (!input || typeof input !== "object" || Array.isArray(input)) return { ok: false, error: { code: "invalid_input", message: "Tool arguments must be an object" } };
      try { return await run(descriptor, input); }
      catch { return { ok: false, error: { code: "tool_failed", message: "PTPP capability unavailable; no successful result was received" } }; }
    },
    // Providers without function calling can still answer a named/selected
    // site's statistics. No mutation or search is run by this fallback.
    fallbackContext: async () => {
      const sites = allowed.find((item) => item.id === "ptpp.sites.list");
      const data = allowed.find((item) => item.id === "ptpp.user_data.get");
      if (!sites || !data) return { status: "unavailable", reason: "Site data tools are not registered" };
      const listing = await run(sites, { limit: 100 }) as { ok: boolean; result?: { items?: Array<Record<string, unknown>> } };
      const scopeText = `${request.prompt ?? ""} ${(request.context?.siteSummary ?? []).map((item) => item.site).join(" ")}`.toLowerCase();
      const selected = (listing.result?.items ?? []).filter((item) => [item.siteId, item.name, item.siteName].some((value) => typeof value === "string" && value.length > 1 && scopeText.includes(value.toLowerCase()))).map((item) => item.siteId).filter((id): id is string => typeof id === "string");
      if (!selected.length) return { status: "unavailable", reason: "Provider does not support tools; no explicit site scope was identified. No search was executed." };
      return { status: "read_only_fallback", data: await run(data, { siteIds: selected, limit: 100 }), searchExecuted: false };
    },
  };
}
