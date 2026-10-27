import assert from "node:assert/strict";
import { startBridge } from "../src/bridge.js";

const bridge = await startBridge({ port: 0, token: "test-token", aiEndpoint: "https://example.test/v1", aiModel: "test" });
try {
  const health = await fetch(`http://${bridge.host}:${bridge.port}/health`);
  assert.equal(health.status, 200);
  const unauthorized = await fetch(`http://${bridge.host}:${bridge.port}/v1/handshake`, { method: "POST", body: "{}" });
  assert.equal(unauthorized.status, 401);
  const handshake = await fetch(`http://${bridge.host}:${bridge.port}/v1/handshake`, {
    method: "POST",
    headers: { Authorization: "Bearer test-token", "Content-Type": "application/json" },
    body: JSON.stringify({ protocol: 1, extensionId: "test", extensionVersion: "0.1.0", browser: "chrome", requestedCapabilities: [] }),
  });
  assert.equal(handshake.status, 200);
  assert.equal((await handshake.json()).ok, true);

  const open = await fetch(`http://${bridge.host}:${bridge.port}/v1/session/open`, {
    method: "POST",
    headers: { Authorization: "Bearer test-token", "Content-Type": "application/json" },
    body: JSON.stringify({
      protocol: 1,
      extensionId: "test-extension",
      extensionVersion: "2.1.0",
      browser: "chrome",
      capabilities: [
        {
          id: "site.user_summary",
          version: 1,
          kind: "query",
          description: "Read the selected site statistics",
          sensitivity: "account",
          confirmation: "none",
          inputSchema: { type: "object" },
          outputSchema: { type: "object" },
          maxResultBytes: 16_384,
        },
        {
          id: "site.sign_in",
          version: 1,
          kind: "action",
          description: "Sign in to a selected site",
          sensitivity: "private",
          confirmation: "required",
          inputSchema: { type: "object" },
          outputSchema: { type: "object" },
          maxResultBytes: 8_192,
        },
      ],
    }),
  });
  assert.equal(open.status, 200);
  const openPayload = (await open.json()) as { sessionId: string; capabilities: Array<{ id: string }> };
  assert.equal(openPayload.capabilities[0]?.id, "site.user_summary");

  const queuedRequest = fetch(`http://${bridge.host}:${bridge.port}/v1/session/${openPayload.sessionId}/request`, {
    method: "POST",
    headers: { Authorization: "Bearer test-token", "Content-Type": "application/json" },
    body: JSON.stringify({
      requestId: "request-12345678",
      capability: "site.user_summary",
      input: { siteIds: ["audiences"], fields: ["uploaded", "nextLevel"] },
    }),
  });
  const poll = await fetch(`http://${bridge.host}:${bridge.port}/v1/session/${openPayload.sessionId}/poll`, {
    method: "POST",
    headers: { Authorization: "Bearer test-token", "Content-Type": "application/json" },
    body: JSON.stringify({ timeoutMs: 1_000 }),
  });
  assert.equal(poll.status, 200);
  const pollPayload = (await poll.json()) as { request?: { requestId?: string; capability?: string } };
  assert.equal(pollPayload.request?.requestId, "request-12345678");
  assert.equal(pollPayload.request?.capability, "site.user_summary");

  const response = await fetch(`http://${bridge.host}:${bridge.port}/v1/session/${openPayload.sessionId}/response`, {
    method: "POST",
    headers: { Authorization: "Bearer test-token", "Content-Type": "application/json" },
    body: JSON.stringify({ requestId: "request-12345678", ok: true, result: { uploaded: 123, nextLevel: { ratio: 2 } } }),
  });
  assert.equal(response.status, 200);
  const requestResult = await (await queuedRequest).json();
  assert.deepEqual(requestResult, { requestId: "request-12345678", ok: true, result: { uploaded: 123, nextLevel: { ratio: 2 } } });

  const actionWithoutConfirmation = await bridge.enqueueToolRequest(openPayload.sessionId, {
    capability: "site.sign_in",
    input: { siteId: "audiences" },
  });
  assert.equal(actionWithoutConfirmation.ok, false);
  assert.equal(actionWithoutConfirmation.error?.code, "confirmation_required");

  const oversizedRequest = fetch(`http://${bridge.host}:${bridge.port}/v1/session/${openPayload.sessionId}/request`, {
    method: "POST",
    headers: { Authorization: "Bearer test-token", "Content-Type": "application/json" },
    body: JSON.stringify({
      requestId: "request-large123",
      capability: "site.user_summary",
      input: {},
    }),
  });
  const oversizedPoll = await fetch(`http://${bridge.host}:${bridge.port}/v1/session/${openPayload.sessionId}/poll`, {
    method: "POST",
    headers: { Authorization: "Bearer test-token", "Content-Type": "application/json" },
    body: JSON.stringify({ timeoutMs: 1_000 }),
  });
  assert.equal(oversizedPoll.status, 200);
  const oversizedResponse = await fetch(`http://${bridge.host}:${bridge.port}/v1/session/${openPayload.sessionId}/response`, {
    method: "POST",
    headers: { Authorization: "Bearer test-token", "Content-Type": "application/json" },
    body: JSON.stringify({ requestId: "request-large123", ok: true, result: { tooLarge: "x".repeat(20_000) } }),
  });
  assert.equal(oversizedResponse.status, 413);
  const oversizedResult = await (await oversizedRequest).json();
  assert.equal(oversizedResult.error?.code, "result_too_large");

  const unknownCapability = await fetch(`http://${bridge.host}:${bridge.port}/v1/session/${openPayload.sessionId}/request`, {
    method: "POST",
    headers: { Authorization: "Bearer test-token", "Content-Type": "application/json" },
    body: JSON.stringify({ requestId: "request-unknown1", capability: "site.passwords", input: {} }),
  });
  assert.equal(unknownCapability.status, 400);
} finally {
  await bridge.close();
}
console.log("MCP bridge tests passed");
