# 安装与启动

## 安装依赖

在 MCP 仓库目录执行：

```powershell
pnpm install
```

复制环境变量模板：

```powershell
Copy-Item .env.example .env
```

然后编辑 `.env`，填入自己的本机令牌和模型服务配置。`.env` 已被 Git 忽略。

## 前台启动

```powershell
pnpm start
```

看到 bridge 已监听本机地址后，再打开 PTPP 的 AI 设置测试连接。

## 后台启动

```powershell
pnpm start:detached
```

后台模式会把日志写入被忽略的 `logs/` 目录。需要停止时结束对应的 Node 进程；不要删除正在使用的 `.env`。
