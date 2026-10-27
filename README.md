# PT-Plugin-Plus MCP

这是 PTPP 的独立 MCP 服务仓库。目标是让 PTPP 的业务能力、界面动作和内置 AI 共用一套可发现、可授权、可审计的工具协议。

此前用于连接浏览器调试端点的测试驱动实现已经移除。MCP 不会调用或封装 Codex 的 Chrome Extension CDP、computer-use，也不把浏览器自动化作为最终连接方案。

## 当前状态

第一阶段（PTPP↔MCP 协议、可选 bridge、AI 请求迁移）已经完成：

- `src/protocol.ts` 定义 PTPP-MCP v1 握手、能力声明、AI 请求结构和二次脱敏；
- `src/bridge.ts` 提供仅监听 `127.0.0.1` 的 HTTP bridge、Bearer token 鉴权、请求大小限制、超时和错误脱敏；
- bridge 已提供 capability session：PTPP 注册能力后，MCP 可以排队请求，扩展通过长轮询取走并回传结果；
- `src/ai.ts` 负责 OpenAI-compatible Chat Completions 请求、模型配置、API Key 和响应解析；
- PTPP 通过 bridge 转发 AI 请求，扩展本身不再保存 LLM endpoint、模型或 API Key。

当前 bridge 是 PTPP 的受控本机连接层，不是浏览器调试端点。标准 stdio MCP 适配器已经提供 `ptpp_sessions`、`ptpp_capabilities` 和 `ptpp_call`，并把调用路由到选定的 PTPP capability session。业务能力由扩展动态声明；扩展未注册的能力不会被执行。PTPP 业务工具按阶段接入，直连外部 MCP 时也必须先发现 capability。

### Capability session（当前第一阶段）

扩展使用同一个 Bearer token 调用：

- `POST /v1/session/open`：提交扩展身份和 capability descriptors；
- `POST /v1/session/:id/poll`：长轮询待处理的工具请求；
- `POST /v1/session/:id/response`：回传工具结果或脱敏错误；
- `POST /v1/session/:id/close`：关闭会话。

MCP 侧通过 `POST /v1/session/:id/request` 排队请求。bridge 只允许请求已注册的 capability；需要确认的写操作在缺少 confirmation token 时会被拒绝。会话、队列、请求体和响应都有上限，具体站点数据字段由扩展端 capability handler 决定。

## 目标

- 在 PTPP 内部建立能力注册表和工具协议；
- 让按钮、表单输入和 AI 工具调用复用同一批业务命令；
- MCP 关闭时，PTPP 保持现有启动和功能不变；
- MCP 启用时，由明确授权的连接层访问这些工具；
- 任何写操作都具备权限分级、确认、脱敏和审计。

## Chrome 扩展限制

MV3 扩展不能像普通 Node 进程一样监听 stdio 或绑定本地 TCP 端口。因此，“单独一个扩展、零外部桥接、任意 MCP 客户端直接连接”不是标准 MCP 的可行部署方式。

可行方向是：

1. PTPP 内置 MCP-compatible tool runtime，供内置 AI 直接调用；
2. 需要外部 MCP 客户端时，增加可选 Native Messaging 或经过认证的本地桥接；
3. 桥接关闭或不可用时，PTPP 完全按普通插件运行。

当前仓库不包含浏览器自动化；主插件桥接已经实现，业务工具仍按清单分阶段接入。

## 开发与验证

```powershell
pnpm typecheck
pnpm test
$env:PTPP_MCP_BRIDGE_TOKEN = "use-a-random-local-secret"
pnpm start -- --stdio
```

服务默认监听 `http://127.0.0.1:19799`。必须通过环境变量显式提供本机 bridge token；服务不会把 token 写入日志。使用 `--stdio` 启动标准 MCP stdio 适配器；若 bridge 已由其他进程启动，可使用 `--connect --stdio` 仅连接现有 bridge。LLM 配置只通过环境变量提供：

- `PTPP_MCP_AI_ENDPOINT`
- `PTPP_MCP_AI_MODEL`
- `PTPP_MCP_AI_API_KEY`
- `PTPP_MCP_AI_TIMEOUT_MS`
- `PTPP_MCP_BRIDGE_TOKEN`
- `PTPP_MCP_BRIDGE_PORT`

不要把 API Key、bridge token 或真实站点数据提交到仓库。
