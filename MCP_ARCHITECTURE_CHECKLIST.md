# PT-Plugin-Plus MCP 架构清单

## 目标定义

- [x] 明确目标是让 PTPP 的业务能力、按钮动作和输入字段可被 MCP 工具调用。
- [x] 明确 MCP 不是 Chrome Extension CDP 或 computer-use 的封装。
- [x] 明确 MCP 关闭后 PTPP 必须保持现有行为。
- [x] 移除错误的浏览器调试端点测试实现。

## PTPP 内部工具层

- [ ] 在主插件中建立 capability registry。
- [ ] 为页面定义稳定的 route、field、action 标识，不依赖 DOM 坐标。
- [ ] 让按钮和表单先调用共享 command/service，再由 MCP 调用同一 command/service。
- [ ] 为站点、搜索、用户数据、签到、下载器、收藏、辅种、备份建立工具分组。
- [ ] 提供 capability discovery：工具名称、参数、返回值、权限等级和当前可用状态。
- [ ] 适配现有 `ProtocolMap`，不复制站点和下载器业务逻辑。

## 内置 AI

- [x] 内置 AI 通过当前 bridge session 使用 PTPP 工具，不依赖浏览器调试插件。
- [x] 支持有限轮次的 OpenAI-compatible tool calling。
- [x] 对不支持 tool calling 的模型提供只读数据 fallback，不假称搜索已执行。
- [x] 限制每次对话的工具调用轮数、结果字节数和最大工具数量。
- [x] 搜索、用户数据分析和解释类操作按用户意图开放；搜索启动仅在用户明确要求时提供。
- [x] 仅读工具进入 AI allowlist；刷新、签到执行、推送、删除、恢复和配置修改不向 AI 暴露。
- [ ] 推送、收藏、签到、备份恢复、删除等操作需要确认。

## 外部 MCP 连接

- [ ] 评估 Native Messaging 作为正式桥接方式。
- [x] 经过随机令牌认证的 localhost HTTP bridge 已作为第一阶段开发桥接方式实现。
- [x] capability session 的 open/poll/request/response/close 通道已实现，并限制为已注册能力。
- [ ] 明确扩展无法自行提供标准 stdio MCP 服务。
- [x] 外部桥接关闭或不可用时，不影响 PTPP 正常启动。
- [x] 标准 MCP stdio 适配器提供 session discovery、capability discovery 和受控通用调用。
- [x] 多个 PTPP profile 同时连接时要求显式 `sessionId`，不会跨 profile 广播调用。
- [x] MCP tool 请求复用 bridge capability session，不直接访问浏览器、DOM、CDP 或 computer-use。

## 安全和隐私

- [x] 默认关闭外部 MCP 桥接。
- [x] Cookie、密码、API Key、WebDAV 凭据永不进入 AI 请求上下文或工具返回值。
- [ ] 写操作使用 allowlist、确认令牌和审计日志。
- [x] MCP adapter 不为确认级操作伪造确认令牌；此类操作要求 PTPP 拥有者确认流程。
- [ ] 删除、恢复、批量下载等操作强制二次确认。
- [ ] 站点搜索和签到设置限流，并保留 `needs_manual` 状态。
