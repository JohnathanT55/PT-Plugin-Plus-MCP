# 配置模型与令牌

环境变量模板中包含以下项目：

- `PTPP_MCP_BRIDGE_TOKEN`：PTPP 连接 bridge 使用的本机令牌。
- `PTPP_MCP_BRIDGE_PORT`：bridge 监听端口；保持本机回环监听。
- `PTPP_MCP_AI_ENDPOINT`：OpenAI-compatible API 的 base URL。
- `PTPP_MCP_AI_MODEL`：使用的模型名称。
- `PTPP_MCP_AI_API_KEY`：模型服务 API Key。
- `PTPP_MCP_AI_TIMEOUT_MS`：模型请求的可选超时覆盖；不填写时使用服务默认值。

修改 `.env` 后重启 MCP 服务。不要把 API Key 或 bridge 令牌写入 PTPP 的备份、截图或公开 issue。

## 为其他 MCP 客户端提供 stdio

这是面向需要把 PTPP 接入其他 MCP 客户端的高级用法。普通用户只需要启动本机 bridge，并在 PTPP 中测试连接。

```powershell
pnpm start -- --stdio
```
