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
} finally {
  await bridge.close();
}
console.log("MCP bridge tests passed");
