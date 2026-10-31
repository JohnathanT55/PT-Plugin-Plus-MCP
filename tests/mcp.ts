import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer, selectSession, type CapabilityBridge, type SessionSummary } from "../src/mcp.js";

const capability = {
  id: "ptpp.user_data.get", version: 1, kind: "query" as const, sensitivity: "account" as const,
  description: "Read site statistics including next-level requirements and unmet values", confirmation: "none" as const,
  inputSchema: { type: "object" }, outputSchema: { type: "object" }, maxResultBytes: 262_144,
};
const confirmationCapability = { ...capability, id: "ptpp.settings.apply_patch", kind: "action" as const, confirmation: "required" as const };
const session: SessionSummary = { sessionId: "session-a", extensionId: "extension-a", extensionVersion: "2.1.0", browser: "chrome", openedAt: Date.now(), expiresAt: Date.now() + 60_000, capabilities: [capability, confirmationCapability] };
const calls: Array<{ sessionId: string; capability: string; input: unknown; confirmationToken?: string }> = [];
const bridge: CapabilityBridge = {
  listSessions: () => [session],
  enqueueToolRequest: async (sessionId, request) => {
    calls.push({ sessionId, capability: request.capability, input: request.input, ...(request.confirmationToken ? { confirmationToken: request.confirmationToken } : {}) });
    if (request.capability === "ptpp.settings.apply_patch" && !request.confirmationToken) {
      return {
        requestId: request.requestId ?? "generated",
        ok: true,
        result: { status: "confirmation_required", confirmationId: "pending-1", summary: "Apply settings" },
      };
    }
    return { requestId: request.requestId ?? "generated", ok: true, result: { items: [{ siteId: "audiences", nextLevel: { requirements: { uploaded: 5 }, unmet: { uploaded: 2 } } }] } };
  },
};

const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
const server = createMcpServer(bridge);
const client = new Client({ name: "test-client", version: "1.0.0" }, { capabilities: {} });
await server.connect(serverTransport);
await client.connect(clientTransport);
try {
  const listed = await client.listTools();
  assert.deepEqual(listed.tools.map((item) => item.name), ["ptpp_sessions", "ptpp_capabilities", "ptpp_call", "ptpp_query", "ptpp_action"]);
  const caps = await client.callTool({ name: "ptpp_capabilities", arguments: {} });
  assert.equal(String((caps as { content?: Array<{ text?: string }> }).content?.[0]?.text).includes("ptpp.user_data.get"), true);
  const data = await client.callTool({ name: "ptpp_call", arguments: { capability: "ptpp.user_data.get", input: { siteIds: ["audiences"], limit: 100 } } });
  assert.equal(String((data as { content?: Array<{ text?: string }> }).content?.[0]?.text).includes('"unmet"'), true);
  assert.deepEqual(calls[0], { sessionId: "session-a", capability: "ptpp.user_data.get", input: { siteIds: ["audiences"], limit: 100 } });
  const queryData = await client.callTool({ name: "ptpp_query", arguments: { capability: "ptpp.user_data.get", input: { siteIds: ["audiences"] } } });
  assert.equal(String((queryData as { content?: Array<{ text?: string }> }).content?.[0]?.text).includes('"items"'), true);
  assert.equal(calls.length, 2);
  const rejectedKind = await client.callTool({ name: "ptpp_query", arguments: { capability: "ptpp.settings.apply_patch", input: {} } });
  assert.equal(String((rejectedKind as { content?: Array<{ text?: string }> }).content?.[0]?.text).includes("unsupported_kind"), true);
  const noApproval = await client.callTool({ name: "ptpp_call", arguments: { capability: "ptpp.settings.apply_patch", input: { proposalId: "pending-1" } } });
  const proposalText = String((noApproval as { content?: Array<{ text?: string }> }).content?.[0]?.text);
  assert.equal(proposalText.includes("confirmation_required"), true);
  assert.equal(proposalText.includes("pending-1"), true, "PTPP confirmationId is returned to the MCP caller");
  assert.equal(calls.length, 3, "first confirmation request reaches PTPP to create a proposal");
  assert.equal(calls[2].confirmationToken, undefined, "adapter does not invent user approval");
  const actionProposal = await client.callTool({ name: "ptpp_action", arguments: { capability: "ptpp.settings.apply_patch", input: { proposalId: "pending-1" } } });
  const actionProposalText = String((actionProposal as { content?: Array<{ text?: string }> }).content?.[0]?.text);
  assert.equal(actionProposalText.includes("confirmation_required"), true, "ptpp_action also forwards the first proposal");
  assert.equal(calls.length, 4);
  assert.equal(calls[3].confirmationToken, undefined);
  await client.callTool({ name: "ptpp_action", arguments: { capability: "ptpp.settings.apply_patch", input: { proposalId: "pending-1" }, confirmationToken: "user-approved-one-time-token" } });
  assert.equal(calls[4].confirmationToken, "user-approved-one-time-token", "PTPP-owned token is passed through for extension-side validation");
  await assert.rejects(() => selectSession({ listSessions: () => [], enqueueToolRequest: bridge.enqueueToolRequest }, undefined), /No PTPP extension/);
  const multi = { listSessions: () => [session, { ...session, sessionId: "session-b" }], enqueueToolRequest: bridge.enqueueToolRequest };
  await assert.rejects(() => selectSession(multi, undefined), /Multiple PTPP sessions/);
  const selected = await selectSession(multi, "session-b");
  assert.equal(selected.sessionId, "session-b");
} finally {
  await client.close();
  await server.close();
}
console.log("MCP standard tool tests passed");
