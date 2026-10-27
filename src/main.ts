import { startBridge } from "./bridge.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createHttpBridgeClient, createMcpServer } from "./mcp.js";

// Pair the extension with this environment token. Never log credentials.
if (!process.env.PTPP_MCP_BRIDGE_TOKEN?.trim()) throw new Error("Set PTPP_MCP_BRIDGE_TOKEN before starting the bridge");
const connectOnly = process.argv.includes("--connect");
const stdio = connectOnly || process.argv.includes("--stdio");
const bridge = connectOnly ? undefined : await startBridge();
if (bridge) console.error(`[PTPP MCP] Local bridge listening on port ${bridge.port}`);
const access = bridge ?? createHttpBridgeClient(`http://127.0.0.1:${Number(process.env.PTPP_MCP_BRIDGE_PORT ?? 19799)}`, process.env.PTPP_MCP_BRIDGE_TOKEN);
const mcp = stdio ? createMcpServer(access) : undefined;
if (mcp) await mcp.connect(new StdioServerTransport());

const close = async () => {
  await mcp?.close();
  await bridge?.close();
  process.exit(0);
};
process.once("SIGINT", close);
process.once("SIGTERM", close);
if (stdio) process.stdin.once("end", close);
