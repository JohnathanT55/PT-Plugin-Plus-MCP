import assert from "node:assert/strict";
import { normalizeEndpoint, requestAiAssistant } from "../src/ai.js";
import { sanitizeAiRequest } from "../src/protocol.js";
import { createAssistantTools, type AiTools } from "../src/assistantTools.js";

assert.equal(normalizeEndpoint("https://example.test"), "https://example.test/v1/chat/completions");
assert.equal(normalizeEndpoint("https://example.test/v1/"), "https://example.test/v1/chat/completions");
assert.throws(() => normalizeEndpoint("file:///tmp/ai"), /HTTP 或 HTTPS/);
assert.throws(() => normalizeEndpoint("https://example.test/v1?api_key=secret"), /凭据/);

const sanitized = sanitizeAiRequest({
  mode: "result-advice",
  prompt: "  分析结果 ",
  context: {
    torrentResults: [{ title: "标题", url: "https://private.example/detail/1", password: "secret" }],
  },
});
assert.equal(sanitized.prompt, "分析结果");
assert.equal((sanitized.context?.torrentResults?.[0] as any).title, "标题");
assert.equal((sanitized.context?.torrentResults?.[0] as any).url, undefined);

const originalFetch = globalThis.fetch;
globalThis.fetch = async () => new Response(JSON.stringify({ choices: [{ message: { content: "建议" } }], model: "local" }), { status: 200 });
const response = await requestAiAssistant({ mode: "test" }, { endpoint: "https://example.test/v1", model: "model", apiKey: "secret", timeoutMs: 1_000 });
assert.equal(response.text, "建议");

let calls = 0;
let capturedMessages: unknown;
const tools: AiTools = {
  tools: [{ type: "function", function: { name: "ptpp__user_data__get", description: "Read complete site stats", parameters: { type: "object", properties: { siteIds: { type: "array" } } } } }],
  execute: async (name, input) => { calls++; assert.equal(name, "ptpp__user_data__get"); assert.deepEqual(input, { siteIds: ["audiences"] }); return { ok: true, result: { items: [{ nextLevel: { requirements: { uploaded: 5 }, unmet: { uploaded: 2 } } }] } }; },
  fallbackContext: async () => ({ status: "unused" }),
};
globalThis.fetch = async (_input, init) => {
  capturedMessages = JSON.parse(String(init?.body)).messages;
  if (calls === 0)
    return new Response(
      JSON.stringify({
        choices: [
          {
            finish_reason: "tool_calls",
            message: {
              content: "",
              reasoning_content: "需要先读取 Audiences 的数据。",
              tool_calls: [
                {
                  id: "call-1",
                  type: "function",
                  function: { name: "ptpp__user_data__get", arguments: JSON.stringify({ siteIds: ["audiences"] }) },
                },
              ],
            },
          },
        ],
      }),
      { status: 200 },
    );
  const assistantMessage = (capturedMessages as any[]).find((message) => message.role === "assistant" && message.tool_calls);
  assert.equal(assistantMessage?.reasoning_content, "需要先读取 Audiences 的数据。", "reasoning content is echoed for compatible tool-call providers");
  return new Response(JSON.stringify({ choices: [{ message: { content: "下一等级还差 2" } }], model: "local" }), { status: 200 });
};
const toolResponse = await requestAiAssistant({ mode: "assist", prompt: "分析 Audiences 下一等级还差多少" }, { endpoint: "https://example.test/v1", model: "model", apiKey: "secret", timeoutMs: 1_000 }, tools);
assert.equal(toolResponse.text, "下一等级还差 2");
assert.equal(calls, 1);
assert.equal(JSON.stringify(capturedMessages).includes('"role":"tool"'), true);

let continuationCalls = 0;
globalThis.fetch = async (_input, init) => {
  continuationCalls++;
  const body = JSON.parse(String(init?.body));
  assert.equal(body.max_tokens, 2_400, "AI requests use the expanded bounded output budget");
  if (continuationCalls === 1) {
    return new Response(
      JSON.stringify({ choices: [{ finish_reason: "length", message: { content: "1. audiences\n2. azusa" } }], model: "local" }),
      { status: 200 },
    );
  }
  assert.equal(body.messages.at(-1)?.role, "user", "continuation adds a user instruction after the partial answer");
  return new Response(
    JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: "\n3. hdsky" } }], model: "local" }),
    { status: 200 },
  );
};
const continuedResponse = await requestAiAssistant(
  { mode: "assist", prompt: "列出全部站点" },
  { endpoint: "https://example.test/v1", model: "model", apiKey: "secret", timeoutMs: 1_000 },
);
assert.equal(continuedResponse.text, "1. audiences\n2. azusa\n3. hdsky", "a length-limited answer is continued exactly once");
assert.equal(continuationCalls, 2, "continuation is bounded to one extra request");

const settingsDescriptor = {
  id: "ptpp.settings.propose_patch",
  version: 1,
  kind: "query" as const,
  sensitivity: "private" as const,
  description: "Propose a settings change",
  confirmation: "none" as const,
  inputSchema: { type: "object" },
  outputSchema: { type: "object" },
  maxResultBytes: 65_536,
};
const settingsCalls: unknown[] = [];
const settingsTools = await createAssistantTools(
  {
    listSessions: () => [
      {
        sessionId: "settings-session",
        extensionId: "extension",
        extensionVersion: "2.1.0",
        browser: "chrome",
        openedAt: Date.now(),
        expiresAt: Date.now() + 60_000,
        capabilities: [settingsDescriptor],
      },
    ],
    enqueueToolRequest: async (_sessionId, input) => {
      settingsCalls.push(input);
      return { requestId: "settings-request", ok: true, result: { status: "proposal", confirmationId: "confirmation-1", changes: [] } };
    },
  },
  { mode: "assist", prompt: "调整搜索设置" },
  "settings-session",
);
assert(settingsTools);
await settingsTools.execute("settings__propose_patch", { changes: [{ path: "searchEntity.queueConcurrency", value: 7 }] });
assert.equal(settingsCalls.length, 1, "models may omit the ptpp namespace without bypassing the registry");
assert.equal((settingsCalls[0] as any).capability, "ptpp.settings.propose_patch");

globalThis.fetch = originalFetch;

console.log("MCP AI protocol tests passed");
