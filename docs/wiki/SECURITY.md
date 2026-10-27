# 安全与隐私

- bridge 只监听本机回环地址，不应暴露到局域网或公网。
- 使用随机、足够长的 `PTPP_MCP_BRIDGE_TOKEN`，并定期更换。
- PTPP 发送的是字段筛选后的业务上下文；MCP 不提供原始 DOM、Cookies、密码、下载器凭据或完整备份内容。
- 模型服务仍会收到你发送的问题和允许的上下文，请选择可信的 OpenAI-compatible 服务。
- 退出使用时停止 bridge，或关闭 PTPP 的 MCP 开关。
- 日志中不应出现 API Key、令牌或站点凭据；发现异常时先停止服务并更换令牌。
