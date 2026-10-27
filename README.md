# PT-Plugin-Plus MCP

PT-Plugin-Plus MCP 是 PT-Plugin-Plus（PTPP）的可选本机助手服务。

它负责两件事：

- 让 PTPP 的 AI 助手使用 OpenAI-compatible API；
- 让经过授权的 MCP 客户端查询 PTPP 已公开的业务能力。

PTPP 本身仍然是浏览器扩展。MCP 服务不读取浏览器配置文件、不操作 Chrome 调试端口，也不会代替 PTPP 保存站点 Cookie、下载器密码或备份凭据。关闭这个服务后，PTPP 仍可作为普通扩展使用。

## 适合谁

如果你只使用 PTPP 的搜索、下载和站点工具栏，不需要安装本项目。

如果你希望在 PTPP 中使用 AI 助手，或者希望让兼容 MCP 的桌面客户端查询 PTPP 数据，再安装本服务即可。

## 快速开始（Windows）

### 1. 准备环境

安装 Node.js 22 或更高版本，并确认 PowerShell 中可以运行：

```powershell
node --version
```

然后在本仓库目录执行：

```powershell
pnpm install
Copy-Item .env.example .env
```

### 2. 编辑 `.env`

打开 `.env`，至少填写以下项目：

```text
PTPP_MCP_BRIDGE_TOKEN=请替换为随机长字符串
PTPP_MCP_AI_ENDPOINT=https://你的模型服务/v1
PTPP_MCP_AI_MODEL=你的模型名称
PTPP_MCP_AI_API_KEY=你的模型服务密钥
```

`PTPP_MCP_BRIDGE_TOKEN` 是 PTPP 与本服务之间的本地连接令牌，不是模型服务的 API Key。端口默认使用 `19799`；如果你修改了 `PTPP_MCP_BRIDGE_PORT`，稍后也要在 PTPP 的 AI 助手设置中填写相同端口。

不要把 `.env` 发给别人，也不要提交到 Git。仓库已经将它加入忽略列表。

### 3. 启动服务

推荐使用后台启动脚本：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\start-bridge.ps1
```

脚本会在后台启动服务，日志保存在本地 `logs/` 目录。需要在当前窗口查看输出时，也可以运行：

```powershell
pnpm start
```

### 4. 在 PTPP 中连接

1. 打开 PTPP 的“常规设置 → AI 助手”。
2. 打开 MCP AI 助手开关。
3. 填写本机地址，例如 `http://127.0.0.1:19799`。
4. 填入与 `.env` 完全相同的 bridge token。
5. 点击“测试连接”，看到“已连接”后保存。

连接成功后，PTPP 页面右下角会出现 AI 助手入口。没有连接成功时，入口会自动隐藏；这不会影响 PTPP 的其他功能。

## 能做什么

AI 助手可以在 PTPP 已开放的范围内：

- 查看站点列表和用户数据摘要；
- 分析等级要求和当前差额；
- 查看下载器状态；
- 发起搜索并读取分页结果；
- 查看签到状态，或执行明确请求的单站签到；
- 查看备份服务和历史摘要；
- 根据当前页面给出搜索、筛选或数据分析建议。

删除备份、恢复备份和实际推送下载不会交给 AI 自动执行。所有业务能力都由 PTPP 显式注册，未注册的能力不会被调用。

## 安全说明

- 服务只监听本机回环地址，不接受局域网或公网连接。
- 模型 API Key 只保存在 MCP 服务的 `.env` 中，不进入 PTPP 配置、备份或 Chrome Sync。
- PTPP 和 MCP 都会过滤 Cookie、密码、认证头、下载器凭据和完整下载链接。
- 页面上下文和对话只按当前请求发送给 MCP；上游模型是否保存请求由模型服务自己的隐私政策决定。
- 请为 bridge token 使用随机值，并不要把日志、`.env` 或真实备份上传到公共位置。

## 常见问题

### PTPP 显示“连接失败”

确认后台服务仍在运行，并检查 PTPP 中的地址、端口和 token 是否与 `.env` 完全一致。修改 `.env` 后需要重新启动服务。

### 服务启动后马上退出

在当前窗口运行 `pnpm start` 查看错误。最常见原因是没有填写 `PTPP_MCP_BRIDGE_TOKEN`，或模型 endpoint、模型名称和 API Key 不完整。

### AI 没有回答或回答超时

先用模型服务自己的接口确认 endpoint 和 API Key 有效，再检查模型名称是否正确。长回答可能需要更长的模型服务超时时间；默认限制会避免服务无限等待。

### 如何停止后台服务

结束对应的 Node 进程即可。日志文件只用于本机排查，删除日志不会影响 PTPP 数据。

## 项目关系

本项目是 PTPP 的独立可选组件，不是浏览器插件。PTPP 项目主页：<https://github.com/JohnathanT55/PT-Plugin-Plus>。

更多说明见 [`docs/PRODUCT_OVERVIEW.md`](./docs/PRODUCT_OVERVIEW.md) 和 [GitHub Wiki](https://github.com/JohnathanT55/PT-Plugin-Plus-MCP/wiki)。需要 stdio 的高级接入方式请参阅 [配置模型与令牌](https://github.com/JohnathanT55/PT-Plugin-Plus-MCP/wiki/CONFIGURATION)。

## License

[MIT](./LICENSE)
