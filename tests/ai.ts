import assert from "node:assert/strict";
import { normalizeEndpoint, requestAiAssistant } from "../src/ai.js";
import { sanitizeAiRequest } from "../src/protocol.js";
import { createAssistantTools, protectToolResult, type AiTools } from "../src/assistantTools.js";

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

let completeLengthCalls = 0;
globalThis.fetch = async () => {
  completeLengthCalls++;
  return new Response(
    JSON.stringify({ choices: [{ finish_reason: completeLengthCalls === 1 ? "length" : "stop", message: { content: completeLengthCalls === 1 ? "两站均已完成。" : "<COMPLETE>" } }] }),
    { status: 200 },
  );
};
const completeLengthResponse = await requestAiAssistant(
  { mode: "assist", prompt: "总结结果" },
  { endpoint: "https://example.test/v1", model: "model", apiKey: "secret", timeoutMs: 1_000 },
);
assert.equal(completeLengthResponse.text, "两站均已完成。", "a continuation completion marker is not shown to the user");
assert.equal(completeLengthCalls, 2, "a length marker is continued even when the visible text ends with punctuation");

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
const applyDescriptor = { ...settingsDescriptor, id: "ptpp.settings.apply_patch", kind: "action" as const, confirmation: "required" as const };
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
        capabilities: [settingsDescriptor, applyDescriptor],
      },
    ],
    enqueueToolRequest: async (_sessionId, input) => {
      settingsCalls.push(input);
      return { requestId: "settings-request", ok: true, result: { status: "proposal", confirmationId: "confirmation-1", executionCapability: applyDescriptor.id, executionInput: { changes: [{ path: "searchEntity.queueConcurrency", value: 7 }] }, changes: [{ path: "searchEntity.queueConcurrency", before: 8, after: 7 }] } };
    },
  },
  { mode: "assist", prompt: "调整搜索设置" },
  "settings-session",
);
assert(settingsTools);
await settingsTools.execute("settings__propose_patch", { changes: [{ path: "searchEntity.queueConcurrency", value: 7 }] });
assert.equal(settingsCalls.length, 1, "models may omit the ptpp namespace without bypassing the registry");
assert.equal((settingsCalls[0] as any).capability, "ptpp.settings.propose_patch");
assert.equal(settingsTools.pendingConfirmations?.[0].capability, "ptpp.settings.apply_patch", "the UI confirmation executes apply, never another proposal");
assert.deepEqual(settingsTools.pendingConfirmations?.[0].input, { changes: [{ path: "searchEntity.queueConcurrency", value: 7 }] });
assert.equal(settingsTools.tools.some((item) => item.function.name === "ptpp__settings__apply_patch"), false, "execution remains human-confirmed, not exposed to the model");
assert.deepEqual(settingsTools.capabilityInventory, { callable: [settingsDescriptor.id], registeredOnly: [applyDescriptor.id] });
await settingsTools.execute("ptpp__settings__apply_patch", { changes: [{ path: "searchEntity.queueConcurrency", value: 7 }] });
assert.equal(settingsCalls.length, 1, "textual approval cannot bypass the UI confirmation");

assert.deepEqual(protectToolResult({ statistics: { uploaded: 10, downloaded: 5, trueUploaded: 0, trueDownloaded: 0 }, nextLevel: { expectedAt: "2027-03-06", registrationStatus: "incomplete", intervalRemaining: "P125D" } }), {
  statistics: { uploaded: 10, downloaded: 5 }, nextLevel: { expectedAt: "2027-03-06", registrationStatus: "incomplete", intervalRemaining: "P125D" },
});
const selectionContext = sanitizeAiRequest({ mode: "assist", prompt: "分析选中站点", context: { page: "my-data", pageInstanceId: "page-1", selection: { source: "selected", siteIds: ["site-a", "site-a"] } } });
assert.deepEqual(selectionContext.context?.selection, { source: "selected", siteIds: ["site-a"] });
assert.equal(selectionContext.context?.pageInstanceId, "page-1");
assert.deepEqual(sanitizeAiRequest({ mode: "assist", prompt: "分析选中站点", context: { selection: { source: "none", siteIds: ["ignored"] } } }).context?.selection?.siteIds, []);

const contextCalls: any[] = [];
const pageBridge = {
  listSessions: () => [{ sessionId: "page-session", extensionId: "extension", extensionVersion: "2.1.0", browser: "chrome", openedAt: 1, expiresAt: Date.now() + 60_000,
    capabilities: ["ptpp.page_context", "ptpp.user_data.get", "ptpp.sites.list"].map((id) => ({ ...settingsDescriptor, id }))
      .concat([{ ...settingsDescriptor, id: "ptpp.operations.list" }]),
  }],
  enqueueToolRequest: async (_id: string, input: any) => { contextCalls.push(input); return { requestId: "context-request", ok: true, result: { available: true, items: [] } }; },
};
const pageTools = (await createAssistantTools(pageBridge, selectionContext))!;
await pageTools.execute("ptpp__page_context", {});
assert.deepEqual(contextCalls[0].input, { page: "my-data", instanceId: "page-1" }, "live selection reads target the asking page instance");
await pageTools.execute("ptpp__page_context", { page: "search" });
assert.deepEqual(contextCalls[1].input, { page: "search" }, "an explicit different page never receives the original instance");
await pageTools.fallbackContext();
assert.deepEqual(contextCalls[2].input, { siteIds: ["site-a"], limit: 100 }, "fallback preserves selected-only scope");
const noneTools = (await createAssistantTools(pageBridge, { mode: "assist", prompt: "只分析选中站点", context: { selection: { source: "none", siteIds: [] }, siteSummary: [{ site: "site-a" }] } }))!;
assert.equal((await noneTools.fallbackContext() as any).status, "unavailable");
assert.equal(contextCalls.length, 3, "missing selection does not silently query every site");
assert(pageTools.capabilityInventory?.registeredOnly.includes("ptpp.operations.list"), "registered-only audit capabilities can be explained without claiming they are AI tools");

let inventoryMessages: any[] = [];
globalThis.fetch = async (_input, init) => { inventoryMessages = JSON.parse(String(init?.body)).messages; return new Response(JSON.stringify({ choices: [{ message: { content: "能力核对" } }] })); };
await requestAiAssistant({ mode: "assist", prompt: "核对工具" }, { endpoint: "https://example.test/v1", model: "model", apiKey: "secret", timeoutMs: 1000 }, pageTools);
assert(inventoryMessages.some((item) => item.role === "system" && item.content.includes('"registeredOnly":["ptpp.operations.list"]')));

globalThis.fetch = originalFetch;

console.log("MCP AI protocol tests passed");
