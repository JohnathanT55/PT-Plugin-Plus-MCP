import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { CapabilityDescriptor, ToolCallRequest, ToolCallResponse } from "./protocol.js";

export interface SessionSummary {
  sessionId: string;
  extensionId: string;
  extensionVersion: string;
  browser: string;
  openedAt: number;
  expiresAt: number;
  capabilities: CapabilityDescriptor[];
}

export interface CapabilityBridge {
  listSessions(): Promise<SessionSummary[]> | SessionSummary[];
  enqueueToolRequest(sessionId: string, request: Omit<ToolCallRequest, "requestId"> & { requestId?: string }): Promise<ToolCallResponse>;
}

export async function selectSession(bridge: CapabilityBridge, sessionId?: string): Promise<SessionSummary> {
  const sessions = await bridge.listSessions();
  if (sessionId) {
    const session = sessions.find((item) => item.sessionId === sessionId);
    if (!session) throw new Error("Requested PTPP session is disconnected or expired; list sessions again");
    return session;
  }
  if (sessions.length === 0) throw new Error("No PTPP extension is connected; enable its MCP bridge first");
  if (sessions.length !== 1) throw new Error("Multiple PTPP sessions are connected; specify sessionId explicitly");
  return sessions[0];
}

function result(value: Record<string, unknown>, isError = false) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value) }], structuredContent: value, ...(isError ? { isError: true } : {}) };
}

function failure(error: unknown) {
  const message = error instanceof Error ? error.message : "PTPP MCP request failed";
  return result({ ok: false, error: { code: "bridge_error", message } }, true);
}

async function callRegisteredCapability(
  bridge: CapabilityBridge,
  options: { sessionId?: string; capability: string; input: Record<string, unknown>; confirmationToken?: string; expectedKind?: "query" | "action" },
) {
  const session = await selectSession(bridge, options.sessionId);
  const descriptor = session.capabilities.find((item) => item.id === options.capability);
  if (!descriptor) return result({ ok: false, error: { code: "unsupported_capability", message: "Capability is not registered by the selected extension" } }, true);
  if (options.expectedKind && descriptor.kind !== options.expectedKind) {
    return result({ ok: false, error: { code: "unsupported_kind", message: `Capability is not a ${options.expectedKind} capability` } }, true);
  }
  // Confirmation is owned by PTPP.  A first action call without a token is
  // deliberately forwarded so PTPP can create a concrete proposal and return
  // its confirmationId/diff.  This adapter never creates or guesses a token;
  // a caller-provided token is passed through for exact extension-side checks.
  const response = await bridge.enqueueToolRequest(session.sessionId, {
    capability: options.capability,
    input: options.input,
    confirmationToken: options.confirmationToken,
  });
  return result({ ...response, sessionId: session.sessionId }, !response.ok);
}

/** Stable tools discover the extension's live registry; no DOM/browser APIs. */
export function createMcpServer(bridge: CapabilityBridge): McpServer {
  const server = new McpServer({ name: "pt-plugin-plus", version: "0.2.0" }, { maxToolInputElements: 5_000 });
  server.registerTool("ptpp_sessions", {
    description: "List connected PTPP extension sessions. No credentials are returned. With multiple sessions, specify sessionId explicitly.",
    inputSchema: {},
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }, async () => {
    try {
      return result({ sessions: (await bridge.listSessions()).map(({ capabilities, ...session }) => ({ ...session, capabilityIds: capabilities.map((item) => item.id) })) });
    } catch (error) { return failure(error); }
  });
  server.registerTool("ptpp_capabilities", {
    description: "Discover PTPP operations, input/output schemas and limits. Read before ptpp_call; use IDs from results, never guessed IDs.",
    inputSchema: { sessionId: z.string().max(100).optional() },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }, async ({ sessionId }) => {
    try {
      const session = await selectSession(bridge, sessionId);
      return result({ sessionId: session.sessionId, capabilities: session.capabilities });
    } catch (error) { return failure(error); }
  });
  server.registerTool("ptpp_call", {
    description: "Execute one registered PTPP business capability. Inspect ptpp_capabilities first. Only perform requested actions. Search/refresh contact sites; sign-in changes daily status. Use returned pagination and job IDs. Credentials stay inside PTPP. No Chrome/CDP automation.",
    inputSchema: {
      sessionId: z.string().max(100).optional(),
      capability: z.string().regex(/^[a-z][a-z0-9_.-]{2,80}$/),
      input: z.record(z.string(), z.unknown()).default({}),
      confirmationToken: z.string().max(200).optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  }, async ({ sessionId, capability, input, confirmationToken }) => {
    try { return await callRegisteredCapability(bridge, { sessionId, capability, input, confirmationToken }); }
    catch (error) { return failure(error); }
  });
  server.registerTool("ptpp_query", {
    description: "Execute one registered read-only PTPP query capability. Inspect ptpp_capabilities first; this tool excludes actions and writes.",
    inputSchema: {
      sessionId: z.string().max(100).optional(),
      capability: z.string().regex(/^ptpp\.[a-z][a-z0-9_.-]{2,80}$/),
      input: z.record(z.string(), z.unknown()).default({}),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ sessionId, capability, input }) => {
    try { return await callRegisteredCapability(bridge, { sessionId, capability, input, expectedKind: "query" }); }
    catch (error) { return failure(error); }
  });
  server.registerTool("ptpp_action", {
    description: "Execute one registered PTPP action capability. Inspect ptpp_capabilities first; actions may require a one-time PTPP confirmation token.",
    inputSchema: {
      sessionId: z.string().max(100).optional(),
      capability: z.string().regex(/^ptpp\.[a-z][a-z0-9_.-]{2,80}$/),
      input: z.record(z.string(), z.unknown()).default({}),
      confirmationToken: z.string().max(200).optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  }, async ({ sessionId, capability, input, confirmationToken }) => {
    try { return await callRegisteredCapability(bridge, { sessionId, capability, input, confirmationToken, expectedKind: "action" }); }
    catch (error) { return failure(error); }
  });
  return server;
}

/** Connect an additional MCP client to an already-running local bridge. */
export function createHttpBridgeClient(baseUrl: string, token: string): CapabilityBridge {
  const url = new URL(baseUrl);
  if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) || !["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error("PTPP bridge client requires a credential-free loopback URL");
  }
  const base = url.toString().replace(/\/$/, "");
  const request = async (path: string, body?: unknown) => {
    const response = await fetch(`${base}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(55_000),
    });
    const payload = await response.json() as Record<string, unknown>;
    if (!response.ok && !(typeof payload.requestId === "string" && payload.ok === false)) throw new Error(`PTPP bridge returned HTTP ${response.status}`);
    return payload;
  };
  return {
    listSessions: async () => (await request("/v1/sessions")).sessions as SessionSummary[],
    enqueueToolRequest: async (sessionId, input) => await request(`/v1/session/${encodeURIComponent(sessionId)}/request`, input) as unknown as ToolCallResponse,
  };
}
