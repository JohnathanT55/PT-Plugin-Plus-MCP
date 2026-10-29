import { z } from "zod";

export const PTPP_MCP_PROTOCOL_VERSION = 1;

/** A capability is an explicit, schema-described bridge operation. */
export const capabilityKindSchema = z.enum(["query", "action"]);
export const capabilitySensitivitySchema = z.enum(["public", "account", "private"]);
export const capabilityConfirmationSchema = z.enum(["none", "required"]);

export const capabilityDescriptorSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9_.-]{2,80}$/),
  version: z.number().int().min(1).max(100),
  kind: capabilityKindSchema,
  description: z.string().max(240),
  sensitivity: capabilitySensitivitySchema,
  confirmation: capabilityConfirmationSchema,
  inputSchema: z.record(z.string(), z.unknown()).default({}),
  outputSchema: z.record(z.string(), z.unknown()).default({}),
  maxResultBytes: z.number().int().min(256).max(256 * 1024).default(32 * 1024),
});
export type CapabilityDescriptor = z.infer<typeof capabilityDescriptorSchema>;

export const sessionOpenRequestSchema = z.object({
  protocol: z.literal(PTPP_MCP_PROTOCOL_VERSION),
  extensionId: z.string().min(1).max(200),
  extensionVersion: z.string().min(1).max(80),
  browser: z.string().min(1).max(80),
  capabilities: z.array(capabilityDescriptorSchema).max(200),
});
export type SessionOpenRequest = z.infer<typeof sessionOpenRequestSchema>;

export const toolCallRequestSchema = z.object({
  requestId: z.string().regex(/^[A-Za-z0-9_-]{8,100}$/),
  capability: z.string().regex(/^[a-z][a-z0-9_.-]{2,80}$/),
  input: z.unknown().default({}),
  confirmationToken: z.string().max(200).optional(),
});
export type ToolCallRequest = z.infer<typeof toolCallRequestSchema>;

export const toolCallResponseSchema = z.object({
  requestId: z.string().regex(/^[A-Za-z0-9_-]{8,100}$/),
  ok: z.boolean(),
  result: z.unknown().optional(),
  error: z
    .object({
      code: z.string().max(80),
      message: z.string().max(500),
    })
    .optional(),
});
export type ToolCallResponse = z.infer<typeof toolCallResponseSchema>;

export const aiAssistModeSchema = z.enum(["assist", "test", "search-draft", "result-advice", "site-summary"]);
export type AiAssistMode = z.infer<typeof aiAssistModeSchema>;

const aiContextSchema = z
  .object({
    searchKey: z.string().max(240).optional(),
    torrentTitles: z.array(z.string().max(180)).max(20).optional(),
    torrentResults: z.array(z.record(z.string(), z.unknown())).max(30).optional(),
    siteSummary: z.array(z.record(z.string(), z.unknown())).max(20).optional(),
    failures: z.array(z.record(z.string(), z.unknown())).max(30).optional(),
  })
  .optional();

export const aiAssistRequestSchema = z.object({
  sessionId: z.string().max(100).optional(),
  mode: aiAssistModeSchema,
  prompt: z.string().max(4_000).optional(),
  history: z
    .array(z.object({ role: z.enum(["user", "assistant"]), content: z.string().max(4_000) }))
    .max(8)
    .optional(),
  context: aiContextSchema,
});
export type AiAssistRequest = z.infer<typeof aiAssistRequestSchema>;

export interface AiAssistResponse {
  text: string;
  model?: string;
  pendingConfirmations?: Array<Record<string, unknown>>;
}

export interface BridgeHandshakeRequest {
  protocol: typeof PTPP_MCP_PROTOCOL_VERSION;
  extensionId: string;
  extensionVersion: string;
  browser: string;
  requestedCapabilities: string[];
}

export interface BridgeHandshakeResponse {
  ok: true;
  protocol: typeof PTPP_MCP_PROTOCOL_VERSION;
  serverVersion: string;
  status: "ready" | "degraded";
  capabilities: string[];
}

export interface BridgeStatus {
  enabled: boolean;
  connected: boolean;
  status: "ready" | "degraded" | "disabled" | "error";
  protocol?: number;
  serverVersion?: string;
  capabilities: string[];
  lastError?: string;
}

export const bridgeHandshakeResponse: BridgeHandshakeResponse = {
  ok: true,
  protocol: PTPP_MCP_PROTOCOL_VERSION,
  serverVersion: "0.1.0",
  status: "ready",
  capabilities: ["assistant.chat", "assistant.test", "capability.sessions"],
};

export function clampAiHistory(history: AiAssistRequest["history"]): NonNullable<AiAssistRequest["history"]> {
  return (history ?? [])
    .filter((item) => item && (item.role === "user" || item.role === "assistant"))
    .map((item) => ({ role: item.role, content: item.content.trim().slice(0, 4_000) }))
    .filter((item) => item.content)
    .slice(-8);
}

export function sanitizeAiRequest(request: AiAssistRequest): AiAssistRequest {
  const parsed = aiAssistRequestSchema.parse(request);
  const context = parsed.context
    ? {
        ...(parsed.context.searchKey ? { searchKey: parsed.context.searchKey.trim().slice(0, 240) } : {}),
        ...(parsed.context.torrentTitles?.length ? { torrentTitles: parsed.context.torrentTitles.map((value) => value.trim().slice(0, 180)).filter(Boolean).slice(0, 20) } : {}),
        ...(parsed.context.torrentResults?.length
          ? {
              torrentResults: parsed.context.torrentResults.slice(0, 30).map((item) => ({
                ...(typeof item.site === "string" ? { site: item.site.slice(0, 80) } : {}),
                ...(typeof item.title === "string" ? { title: item.title.slice(0, 180) } : {}),
                ...(typeof item.subTitle === "string" ? { subTitle: item.subTitle.slice(0, 180) } : {}),
                ...(typeof item.category === "string" || typeof item.category === "number" ? { category: item.category } : {}),
                ...(typeof item.size === "number" && Number.isFinite(item.size) ? { size: item.size } : {}),
                ...(typeof item.seeders === "number" && Number.isFinite(item.seeders) ? { seeders: item.seeders } : {}),
                ...(typeof item.leechers === "number" && Number.isFinite(item.leechers) ? { leechers: item.leechers } : {}),
                ...(typeof item.completed === "number" && Number.isFinite(item.completed) ? { completed: item.completed } : {}),
                ...(typeof item.comments === "number" && Number.isFinite(item.comments) ? { comments: item.comments } : {}),
                ...(Array.isArray(item.tags) ? { tags: item.tags.filter((tag): tag is string => typeof tag === "string").map((tag) => tag.slice(0, 60)).slice(0, 12) } : {}),
              })),
            }
          : {}),
        ...(parsed.context.siteSummary?.length
          ? {
              siteSummary: parsed.context.siteSummary.slice(0, 20).map((item) => ({
                ...(typeof item.site === "string" ? { site: item.site.slice(0, 80) } : {}),
                ...(typeof item.level === "string" ? { level: item.level.slice(0, 80) } : {}),
                ...(typeof item.ratio === "number" && Number.isFinite(item.ratio) ? { ratio: item.ratio } : {}),
                ...(typeof item.uploaded === "number" && Number.isFinite(item.uploaded) ? { uploaded: item.uploaded } : {}),
                ...(typeof item.downloaded === "number" && Number.isFinite(item.downloaded) ? { downloaded: item.downloaded } : {}),
                ...(typeof item.seeding === "number" && Number.isFinite(item.seeding) ? { seeding: item.seeding } : {}),
                ...(typeof item.seedingSize === "number" && Number.isFinite(item.seedingSize) ? { seedingSize: item.seedingSize } : {}),
                ...(typeof item.bonus === "number" && Number.isFinite(item.bonus) ? { bonus: item.bonus } : {}),
                ...(typeof item.hnr === "number" && Number.isFinite(item.hnr) ? { hnr: item.hnr } : {}),
                ...(typeof item.updatedAt === "string" ? { updatedAt: item.updatedAt.slice(0, 48) } : {}),
                ...(item.nextLevel && typeof item.nextLevel === "object" ? { nextLevel: item.nextLevel } : {}),
              })),
            }
          : {}),
        ...(parsed.context.failures?.length
          ? {
              failures: parsed.context.failures.slice(0, 30).map((item) => ({
                ...(typeof item.site === "string" ? { site: item.site.slice(0, 80) } : {}),
                ...(typeof item.stage === "string" ? { stage: item.stage.slice(0, 60) } : {}),
                ...(typeof item.status === "string" ? { status: item.status.slice(0, 80) } : {}),
                ...(typeof item.message === "string" ? { message: item.message.slice(0, 240) } : {}),
              })),
            }
          : {}),
      }
    : undefined;
  const sanitized: AiAssistRequest = {
    mode: parsed.mode,
    ...(parsed.prompt?.trim() ? { prompt: parsed.prompt.trim().slice(0, 4_000) } : {}),
    ...(clampAiHistory(parsed.history).length ? { history: clampAiHistory(parsed.history) } : {}),
    ...(context && Object.keys(context).length ? { context } : {}),
  };
  if (JSON.stringify(sanitized).length <= 32_000) return sanitized;
  return {
    ...sanitized,
    context: sanitized.context
      ? {
          searchKey: sanitized.context.searchKey,
          torrentTitles: sanitized.context.torrentTitles?.slice(0, 8),
          torrentResults: sanitized.context.torrentResults?.slice(0, 12),
          siteSummary: sanitized.context.siteSummary?.slice(0, 8),
          failures: sanitized.context.failures?.slice(0, 12),
        }
      : undefined,
  };
}
