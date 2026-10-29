import type { AiAssistRequest, CapabilityDescriptor } from "./protocol.js";
import { selectSession, type CapabilityBridge } from "./mcp.js";

const READ_CAPABILITIES = new Set([
  "ptpp.sites.list", "ptpp.user_data.get", "ptpp.downloaders.list", "ptpp.downloaders.status",
  "ptpp.search.status", "ptpp.search.results", "ptpp.signin.status", "ptpp.backups.list", "ptpp.backups.history",
  "ptpp.movies.search", "ptpp.movies.get", "ptpp.search.plans",
  "ptpp.settings.get", "ptpp.settings.validate", "ptpp.settings.propose_patch",
]);
const latestSearchJobs = new Map<string, string>();

export interface AiTool {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
}
export interface AiTools {
  tools: AiTool[];
  execute(name: string, input: unknown): Promise<unknown>;
  fallbackContext(): Promise<unknown>;
  pendingConfirmations?: Array<Record<string, unknown>>;
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
  const resolveDescriptor = (name: string): CapabilityDescriptor | undefined => {
    const exact = byName.get(name);
    if (exact) return exact;
    // Some OpenAI-compatible models normalize function names by dropping the
    // `ptpp__` namespace. Keep advertised names stable while accepting this
    // harmless alias; the resolved descriptor still comes from the extension
    // registry, so aliases cannot broaden the available operations.
    return byName.get(name.startsWith("ptpp__") ? name : `ptpp__${name}`);
  };
  const pendingConfirmations: Array<Record<string, unknown>> = [];
  const run = async (descriptor: CapabilityDescriptor, input: unknown) => {
    let effectiveInput = input;
    if ((descriptor.id === "ptpp.search.status" || descriptor.id === "ptpp.search.results") && input && typeof input === "object" && !Array.isArray(input) && !(input as any).jobId) {
      const latest = latestSearchJobs.get(session.sessionId);
      if (latest) effectiveInput = { ...(input as Record<string, unknown>), jobId: latest };
    }
    const result = await bridge.enqueueToolRequest(session.sessionId, { capability: descriptor.id, input: effectiveInput });
    if (result.ok && descriptor.id === "ptpp.search.start" && result.result && typeof result.result === "object" && typeof (result.result as any).jobId === "string") {
      latestSearchJobs.set(session.sessionId, (result.result as any).jobId);
    }
    if (result.ok && result.result && typeof result.result === "object") {
      const proposal = result.result as Record<string, unknown>;
      if (proposal.status === "proposal" && typeof proposal.confirmationId === "string") {
        const proposalInput = input && typeof input === "object" && !Array.isArray(input)
          ? (Array.isArray((input as any).changes)
            ? { changes: (input as any).changes }
            : (input as any).patch && typeof (input as any).patch === "object"
              ? { changes: Object.entries((input as any).patch).map(([path, value]) => ({ path, value })) }
              : { changes: [] })
          : { changes: [] };
        pendingConfirmations.push({
          confirmationId: proposal.confirmationId,
          capability: descriptor.id,
          summary: typeof proposal.summary === "string" ? proposal.summary : "确认设置修改",
          diff: Array.isArray(proposal.changes) ? proposal.changes : [],
          expiresAt: typeof proposal.expiresAt === "number" ? proposal.expiresAt : undefined,
          input: proposalInput,
        });
        return protectToolResult(result);
      }
    }
    return protectToolResult(result);
  };
  return {
    tools: [...byName].map(([name, descriptor]) => ({ type: "function", function: {
      name,
      description: descriptor.description + ((descriptor.id === "ptpp.search.status" || descriptor.id === "ptpp.search.results") ? " If jobId is omitted, use the latest search started in this conversation." : ""),
      parameters: descriptor.inputSchema?.type
        ? ((descriptor.id === "ptpp.search.status" || descriptor.id === "ptpp.search.results")
          ? { ...descriptor.inputSchema, required: [] }
          : descriptor.inputSchema)
        : { type: "object", properties: {} },
    } })),
    execute: async (name, input) => {
      const descriptor = resolveDescriptor(name);
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
    pendingConfirmations,
  };
}
