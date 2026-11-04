# PT-Plugin-Plus MCP 架构清单

## 目标定义

- [x] 明确目标是让 PTPP 的业务能力、按钮动作和输入字段可被 MCP 工具调用。
- [x] 明确 MCP 不是 Chrome Extension CDP 或 computer-use 的封装。
- [x] 明确 MCP 关闭后 PTPP 必须保持现有行为。
- [x] 移除错误的浏览器调试端点测试实现。

## PTPP 内部工具层

- [x] 在主插件中建立 capability registry。
- [x] 为已注册业务定义稳定的 capability、输入和 action 标识，不依赖 DOM 坐标；未覆盖页面仍列在 PTPP 的覆盖清单中。
- [ ] 让按钮和表单先调用共享 command/service，再由 MCP 调用同一 command/service。
- [x] 为站点、搜索、用户数据、签到、下载器、收藏、辅种、备份建立当前范围内的工具分组。
- [x] 提供 capability discovery：工具名称、参数、返回值、权限等级和当前可用状态。
- [x] 当前 capability 复用 PTPP 已有站点和下载器消息入口，不复制站点和下载器业务逻辑；完整 UI command/service 收口仍待后续批次。

## 内置 AI

- [x] 内置 AI 通过当前 bridge session 使用 PTPP 工具，不依赖浏览器调试插件。
- [x] 支持有限轮次的 OpenAI-compatible tool calling。
- [x] 对不支持 tool calling 的模型提供只读数据 fallback，不假称搜索已执行。
- [x] 限制每次对话的工具调用轮数、结果字节数和最大工具数量。
- [x] 搜索、用户数据分析和解释类操作按用户意图开放；搜索启动仅在用户明确要求时提供。
- [x] 仅读工具进入 AI allowlist；刷新、签到执行、推送、删除、恢复和配置修改不向 AI 暴露。
- [x] action/ptpp_call 的确认级操作首调会转发到 PTPP，由扩展生成 confirmationId/差异；后续调用只原样转发用户提供的一次性令牌，MCP 不伪造审批。
- [x] 对服务端 `finish_reason=length` 执行一次有界续写，并过滤内部 `<COMPLETE>` 标记；不会因句末标点跳过可能缺失的回答尾部。

## 外部 MCP 连接

- [ ] 评估 Native Messaging 作为正式桥接方式。
- [x] 经过随机令牌认证的 localhost HTTP bridge 已作为第一阶段开发桥接方式实现。
- [x] capability session 的 open/poll/request/response/close 通道已实现，并限制为已注册能力。
- [ ] 明确扩展无法自行提供标准 stdio MCP 服务。
- [x] 外部桥接关闭或不可用时，不影响 PTPP 正常启动。
- [x] 标准 MCP stdio 适配器提供 session discovery、capability discovery 和受控通用调用。
- [x] 多个 PTPP profile 同时连接时要求显式 `sessionId`，不会跨 profile 广播调用。
- [x] MCP tool 请求复用 bridge capability session，不直接访问浏览器、DOM、CDP 或 computer-use。

## 本轮业务能力验收

- [x] 标准 `ptpp_query`、`ptpp_action` 与兼容 `ptpp_call` 复用 PTPP capability registry，并按 descriptor.kind 做路由。
- [x] 多会话必须显式选择 session；只读投影和分页能力通过 PTPP bridge 返回，敏感 URL、磁链、路径和凭据不跨边界。
- [x] confirmation-required action 的首次 proposal 可到达 PTPP 生成 confirmationId；MCP 仅透传后续用户令牌。
- [x] PTPP 搜索运行态使用搜索代际保护，外部 MCP 的异步页面交接不会让旧搜索覆盖新搜索结果。

## 安全和隐私

- [x] 默认关闭外部 MCP 桥接。
- [x] Cookie、密码、API Key、WebDAV 凭据永不进入 AI 请求上下文或工具返回值。
- [x] 已注册写操作使用 allowlist 和 PTPP 签发的一次性确认令牌；扩展侧 operation journal 保存脱敏结果摘要、去重关系及中断后的 `unknown` 状态。
- [ ] 尚未把所有页面表单、恢复/清理、站点/下载器配置和内容页动作纳入同一审计/确认闭环。
- [x] MCP adapter 不为确认级操作伪造确认令牌；此类操作要求 PTPP 拥有者确认流程。
- [x] 已注册的删除、批量下载提交和下载历史重试强制二次确认；备份恢复、清理及其余未注册写操作仍未开放。
- [ ] 站点搜索和签到设置限流，并保留 `needs_manual` 状态。
