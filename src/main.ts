import { startBridge } from "./bridge.js";

const bridge = await startBridge();
console.error(`[PTPP MCP] Bridge listening on http://${bridge.host}:${bridge.port}`);
console.error(`[PTPP MCP] Bridge token: ${bridge.token}`);

const close = async () => {
  await bridge.close();
  process.exit(0);
};
process.once("SIGINT", close);
process.once("SIGTERM", close);
