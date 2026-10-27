import assert from "node:assert/strict";
import { normalizeEndpoint, requestAiAssistant } from "../src/ai.js";
import { sanitizeAiRequest } from "../src/protocol.js";

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
globalThis.fetch = originalFetch;

console.log("MCP AI protocol tests passed");
