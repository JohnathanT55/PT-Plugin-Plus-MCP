import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import { requestAiAssistant } from "./ai.js";
import {
  aiAssistRequestSchema,
  bridgeHandshakeResponse,
  PTPP_MCP_PROTOCOL_VERSION,
  sanitizeAiRequest,
  sessionOpenRequestSchema,
  toolCallRequestSchema,
  toolCallResponseSchema,
  type BridgeHandshakeRequest,
  type CapabilityDescriptor,
  type SessionOpenRequest,
  type ToolCallRequest,
  type ToolCallResponse,
} from "./protocol.js";

export interface BridgeConfig {
  host?: string;
  port?: number;
  token?: string;
  aiEndpoint?: string;
  aiModel?: string;
  aiApiKey?: string;
  aiTimeoutMs?: number;
}

export interface RunningBridge {
  host: string;
  port: number;
  token: string;
  enqueueToolRequest(sessionId: string, request: Omit<ToolCallRequest, "requestId"> & { requestId?: string }): Promise<ToolCallResponse>;
  close(): Promise<void>;
}

const MAX_BODY_BYTES = 256 * 1024;
const MAX_SESSION_QUEUE = 32;
const SESSION_TTL_MS = 10 * 60_000;
const MAX_POLL_MS = 30_000;
const TOOL_CALL_TIMEOUT_MS = 45_000;

interface Session {
  id: string;
  openedAt: number;
  expiresAt: number;
  metadata: Omit<SessionOpenRequest, "capabilities">;
  capabilities: Map<string, CapabilityDescriptor>;
  queue: ToolCallRequest[];
  pollWaiter?: (request: ToolCallRequest | null) => void;
  pollTimer?: ReturnType<typeof setTimeout>;
  pending: Map<
    string,
    { resolve: (response: ToolCallResponse) => void; timer: ReturnType<typeof setTimeout>; maxResultBytes: number }
  >;
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Access-Control-Allow-Origin", "*");
  response.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
  response.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  response.end(JSON.stringify(body));
}

async function readBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk as Uint8Array);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new Error("MCP bridge request is too large");
    chunks.push(buffer);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function authorized(request: IncomingMessage, token: string): boolean {
  return request.headers.authorization === `Bearer ${token}`;
}

function createId(bytes = 18): string {
  return randomBytes(bytes).toString("base64url");
}

function jsonByteLength(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value) ?? "null", "utf8");
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function parseSessionPath(requestUrl: string | undefined): { sessionId: string; action: "poll" | "request" | "response" | "close" } | undefined {
  const parsed = new URL(requestUrl ?? "/", "http://localhost");
  const match = parsed.pathname.match(/^\/v1\/session\/([^/]+)\/(poll|request|response|close)$/);
  if (!match) return undefined;
  return { sessionId: decodeURIComponent(match[1]), action: match[2] as "poll" | "request" | "response" | "close" };
}

function closeSession(session: Session): void {
  if (session.pollTimer) clearTimeout(session.pollTimer);
  session.pollWaiter?.(null);
  session.pollWaiter = undefined;
  for (const [requestId, pending] of session.pending) {
    clearTimeout(pending.timer);
    pending.resolve({
      requestId,
      ok: false,
      error: { code: "session_closed", message: "PTPP MCP session closed" },
    });
  }
  session.pending.clear();
}

function deliverQueuedRequest(session: Session): void {
  if (!session.pollWaiter || session.queue.length === 0) return;
  const waiter = session.pollWaiter;
  session.pollWaiter = undefined;
  if (session.pollTimer) clearTimeout(session.pollTimer);
  session.pollTimer = undefined;
  waiter(session.queue.shift() ?? null);
}

function pollSession(session: Session, timeoutMs: number): Promise<ToolCallRequest | null> {
  deliverQueuedRequest(session);
  const queued = session.queue.shift();
  if (queued) return Promise.resolve(queued);
  if (session.pollWaiter) return Promise.resolve(null);
  const bounded = Math.min(MAX_POLL_MS, Math.max(0, Math.round(timeoutMs)));
  return new Promise((resolve) => {
    session.pollWaiter = resolve;
    session.pollTimer = setTimeout(() => {
      session.pollWaiter = undefined;
      session.pollTimer = undefined;
      resolve(null);
    }, bounded);
  });
}

export async function startBridge(config: BridgeConfig = {}): Promise<RunningBridge> {
  const host = config.host ?? "127.0.0.1";
  const port = config.port ?? Number(process.env.PTPP_MCP_BRIDGE_PORT ?? 19799);
  const token = config.token ?? process.env.PTPP_MCP_BRIDGE_TOKEN ?? randomBytes(24).toString("base64url");
  const aiEndpoint = config.aiEndpoint ?? process.env.PTPP_MCP_AI_ENDPOINT ?? "";
  const aiModel = config.aiModel ?? process.env.PTPP_MCP_AI_MODEL ?? "";
  const aiApiKey = config.aiApiKey ?? process.env.PTPP_MCP_AI_API_KEY ?? "";
  const aiTimeoutMs = config.aiTimeoutMs ?? Number(process.env.PTPP_MCP_AI_TIMEOUT_MS ?? 30_000);
  const sessions = new Map<string, Session>();

  const removeExpiredSessions = () => {
    const now = Date.now();
    for (const [id, session] of sessions) {
      if (session.expiresAt <= now) {
        closeSession(session);
        sessions.delete(id);
      }
    }
  };

  const enqueueToolRequest = (sessionId: string, input: Omit<ToolCallRequest, "requestId"> & { requestId?: string }) => {
    removeExpiredSessions();
    const session = sessions.get(sessionId);
    if (!session) throw new Error("MCP session not found or expired");
    const request = toolCallRequestSchema.parse({ ...input, requestId: input.requestId ?? createId() });
    const descriptor = session.capabilities.get(request.capability);
    if (!descriptor) throw new Error(`Capability is not registered: ${request.capability}`);
    if (descriptor.kind === "action" && descriptor.confirmation === "required" && !request.confirmationToken) {
      return Promise.resolve({
        requestId: request.requestId,
        ok: false,
        error: { code: "confirmation_required", message: "This capability requires explicit confirmation" },
      });
    }
    if (session.queue.length >= MAX_SESSION_QUEUE) {
      return Promise.resolve({
        requestId: request.requestId,
        ok: false,
        error: { code: "queue_full", message: "PTPP MCP session request queue is full" },
      });
    }
    return new Promise<ToolCallResponse>((resolve) => {
      const timer = setTimeout(() => {
        session.pending.delete(request.requestId);
        resolve({ requestId: request.requestId, ok: false, error: { code: "timeout", message: "PTPP did not respond in time" } });
      }, TOOL_CALL_TIMEOUT_MS);
      session.pending.set(request.requestId, { resolve, timer, maxResultBytes: descriptor.maxResultBytes });
      session.queue.push(request);
      deliverQueuedRequest(session);
    });
  };

  const server = createServer(async (request, response) => {
    if (request.method === "OPTIONS") return sendJson(response, 204, {});
    try {
      if (request.url === "/health" && request.method === "GET") return sendJson(response, 200, { ok: true, protocol: PTPP_MCP_PROTOCOL_VERSION, service: "pt-plugin-plus-mcp" });
      if (!authorized(request, token)) return sendJson(response, 401, { ok: false, error: "MCP bridge authorization failed" });
      if (request.url === "/v1/handshake" && request.method === "POST") {
        const body = await readBody(request) as BridgeHandshakeRequest;
        if (body.protocol !== PTPP_MCP_PROTOCOL_VERSION || typeof body.extensionId !== "string") return sendJson(response, 400, { ok: false, error: "Unsupported PTPP MCP protocol" });
        return sendJson(response, 200, bridgeHandshakeResponse);
      }
      if (request.url === "/v1/session/open" && request.method === "POST") {
        const body = sessionOpenRequestSchema.parse(await readBody(request));
        const id = createId();
        const now = Date.now();
        const session: Session = {
          id,
          openedAt: now,
          expiresAt: now + SESSION_TTL_MS,
          metadata: {
            protocol: body.protocol,
            extensionId: body.extensionId,
            extensionVersion: body.extensionVersion,
            browser: body.browser,
          },
          capabilities: new Map(body.capabilities.map((capability) => [capability.id, capability])),
          queue: [],
          pending: new Map(),
        };
        sessions.set(id, session);
        return sendJson(response, 200, {
          ok: true,
          protocol: PTPP_MCP_PROTOCOL_VERSION,
          sessionId: id,
          expiresAt: session.expiresAt,
          capabilities: body.capabilities,
        });
      }
      if (request.url === "/v1/assistant" && request.method === "POST") {
        const body = aiAssistRequestSchema.parse(await readBody(request));
        const result = await requestAiAssistant(sanitizeAiRequest(body), { endpoint: aiEndpoint, model: aiModel, apiKey: aiApiKey, timeoutMs: aiTimeoutMs });
        return sendJson(response, 200, { ok: true, ...result });
      }
      const sessionPath = parseSessionPath(request.url);
      if (sessionPath) {
        removeExpiredSessions();
        const session = sessions.get(sessionPath.sessionId);
        if (!session) return sendJson(response, 404, { ok: false, error: "MCP session not found or expired" });
        if (sessionPath.action === "poll" && request.method === "POST") {
          const body = (await readBody(request)) as { timeoutMs?: unknown };
          const timeoutMs = Number(body?.timeoutMs);
          const toolRequest = await pollSession(session, Number.isFinite(timeoutMs) ? timeoutMs : MAX_POLL_MS);
          session.expiresAt = Date.now() + SESSION_TTL_MS;
          return sendJson(response, 200, { ok: true, request: toolRequest });
        }
        if (sessionPath.action === "request" && request.method === "POST") {
          const body = toolCallRequestSchema.parse(await readBody(request));
          const result = await enqueueToolRequest(session.id, body);
          return sendJson(response, result.ok ? 200 : 409, result);
        }
        if (sessionPath.action === "response" && request.method === "POST") {
          const result = toolCallResponseSchema.parse(await readBody(request));
          const pending = session.pending.get(result.requestId);
          if (!pending) return sendJson(response, 404, { ok: false, error: "Tool request not found or already timed out" });
          clearTimeout(pending.timer);
          session.pending.delete(result.requestId);
          if (result.ok && jsonByteLength(result.result) > pending.maxResultBytes) {
            pending.resolve({
              requestId: result.requestId,
              ok: false,
              error: { code: "result_too_large", message: "Capability result exceeded its declared size limit" },
            });
            return sendJson(response, 413, { ok: false, error: "Capability result exceeded its declared size limit" });
          }
          pending.resolve(result);
          session.expiresAt = Date.now() + SESSION_TTL_MS;
          return sendJson(response, 200, { ok: true });
        }
        if (sessionPath.action === "close" && request.method === "POST") {
          closeSession(session);
          sessions.delete(session.id);
          return sendJson(response, 200, { ok: true });
        }
      }
      return sendJson(response, 404, { ok: false, error: "MCP bridge route not found" });
    } catch (error) {
      return sendJson(response, 400, { ok: false, error: error instanceof Error ? error.message : "MCP bridge request failed" });
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolve());
  });
  const actualPort = typeof server.address() === "object" && server.address() ? (server.address() as AddressInfo).port : port;
  return {
    host,
    port: actualPort,
    token,
    enqueueToolRequest,
    close: async () => {
      for (const session of sessions.values()) closeSession(session);
      sessions.clear();
      return await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    },
  };
}
