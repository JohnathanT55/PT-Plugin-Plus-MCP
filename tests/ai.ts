import assert from "node:assert/strict";
import { normalizeEndpoint, requestAiAssistant } from "../src/ai.js";
import { sanitizeAiRequest } from "../src/protocol.js";
import type { AiTools } from "../src/assistantTools.js";

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
  if (calls === 0) return new Response(JSON.stringify({ choices: [{ message: { tool_calls: [{ id: "call-1", type: "function", function: { name: "ptpp__user_data__get", arguments: JSON.stringify({ siteIds: ["audiences"] }) } }] } }] }), { status: 200 });
  return new Response(JSON.stringify({ choices: [{ message: { content: "下一等级还差 2" } }], model: "local" }), { status: 200 });
};
const toolResponse = await requestAiAssistant({ mode: "assist", prompt: "分析 Audiences 下一等级还差多少" }, { endpoint: "https://example.test/v1", model: "model", apiKey: "secret", timeoutMs: 1_000 }, tools);
assert.equal(toolResponse.text, "下一等级还差 2");
assert.equal(calls, 1);
assert.equal(JSON.stringify(capturedMessages).includes('"role":"tool"'), true);
globalThis.fetch = originalFetch;

console.log("MCP AI protocol tests passed");
