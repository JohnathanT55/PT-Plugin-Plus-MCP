import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import { requestAiAssistant } from "./ai.js";
import { aiAssistRequestSchema, bridgeHandshakeResponse, PTPP_MCP_PROTOCOL_VERSION, sanitizeAiRequest, type BridgeHandshakeRequest } from "./protocol.js";

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
  close(): Promise<void>;
}

const MAX_BODY_BYTES = 256 * 1024;

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

export async function startBridge(config: BridgeConfig = {}): Promise<RunningBridge> {
  const host = config.host ?? "127.0.0.1";
  const port = config.port ?? Number(process.env.PTPP_MCP_BRIDGE_PORT ?? 19799);
  const token = config.token ?? process.env.PTPP_MCP_BRIDGE_TOKEN ?? randomBytes(24).toString("base64url");
  const aiEndpoint = config.aiEndpoint ?? process.env.PTPP_MCP_AI_ENDPOINT ?? "";
  const aiModel = config.aiModel ?? process.env.PTPP_MCP_AI_MODEL ?? "";
  const aiApiKey = config.aiApiKey ?? process.env.PTPP_MCP_AI_API_KEY ?? "";
  const aiTimeoutMs = config.aiTimeoutMs ?? Number(process.env.PTPP_MCP_AI_TIMEOUT_MS ?? 30_000);

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
      if (request.url === "/v1/assistant" && request.method === "POST") {
        const body = aiAssistRequestSchema.parse(await readBody(request));
        const result = await requestAiAssistant(sanitizeAiRequest(body), { endpoint: aiEndpoint, model: aiModel, apiKey: aiApiKey, timeoutMs: aiTimeoutMs });
        return sendJson(response, 200, { ok: true, ...result });
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
  return { host, port: actualPort, token, close: async () => await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())) };
}
