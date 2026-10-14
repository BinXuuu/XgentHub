# Xgent Hub

[English](README.en.md) | 中文

Xgent Hub 是一个本机 Agent 控制台，把你电脑上装的 coding agent 放到同一个网页工作台里统一使用：Codex、Claude Code、Antigravity、OpenClaw、Ark CLI、Ollama，以及任何 OpenAI 兼容 API。可以用桌面版、浏览器或手机打开。核心是任务看板、审批队列和 Diff 审阅，而不是一个"模型下拉框 + 聊天框"。

> 目前只支持 Windows 10 / 11：服务脚本、安装器和调用 CLI 的方式都是按 Windows 写的。

## 功能

- **任务**：让 Agent 在指定的工作区文件夹里干活，实时看到它的消息、终端输出、文件改动和 Diff。可以中途停止、继续对话，或者把任务转交给另一个 Agent 和模型。
- **审批队列**：装依赖、跑命令、`git push`、碰密钥文件这类有风险的操作会先等你批准。Claude Code 自己每次调用工具前的确认也会进同一个队列。有待审批时会弹窗、响提示音、改标签页标题、在导航上显示数字。
- **每个任务三档权限**：请求批准、帮我批准（只有高风险操作问你）、完全访问。
- **撤回**：Agent 每一轮改动前都会存快照，可以把工作区退回到某一轮之前。
- **AI 智能拆分**：描述一个大一点的需求，让它拆成多个子任务分给不同的 Agent 和模型，再用流程图跟进进度。
- **聊天**：不需要工作区的轻量对话，可以选任意 Agent。
- **角色**：把一个 Agent + 模型包装成固定身份（比如"美工""文案"），带自己的说明和知识库。
- **知识库、Skill、工具和 MCP**：统一管理一次，再挂到工作区、聊天或角色上。
- **Agent 诊断**：每个 Agent 的配置页会检查 CLI 装没装、登没登录，列出模型和用量，并给出一步步的安装说明。
- **桌面版**：Electron 桌面壳，会自动拉起本地服务并自动登录。
- **手机访问**：在局域网或 Tailscale 里用手机打开。
- **数据安全**：启动时和每 24 小时自动备份数据库，附带恢复脚本。

## 环境要求

- Windows 10 或 11
- [Node.js](https://nodejs.org/) 22.5 或更新版本（用到内置的 `node:sqlite` 和 TypeScript 类型擦除）
- 至少一个 Agent：比如 Codex、Claude Code 这类 CLI，本机的 Ollama，或者一个 OpenAI 兼容服务的 API Key

## 安装

```bash
git clone <本仓库地址> XgentHub
cd XgentHub
install.bat
```

`install.bat` 会从 `.env.example` 生成 `.env` 并随机生成登录令牌 `ADMIN_TOKEN`，然后运行 `npm install`、`npm run build`，最后跑一遍自检（`doctor.bat`）。

可选参数（创建快捷方式、开机启动、装完直接启动）：

```bash
install.bat -InstallShortcuts -InstallStartupTask -StartAfterInstall
```

启动方式：

- `start-app.bat`：打开桌面版。服务没启动会自动拉起，并用 `.env` 里的令牌自动登录。
- `start-prod.bat`：只启动后台服务。浏览器打开 `http://127.0.0.1:4180`，用 `.env` 里 `ADMIN_TOKEN=` 后面那串登录。

第一次打开会进入配置中心向导：环境自检、本机发现（找到已装的 CLI 并把路径写进 `.env`）、添加 Agent、开机启动、创建测试任务。默认工作区会建在 `%USERPROFILE%\XgentHub-Workspace`。

## 支持的 Agent

| Agent | 接入方式 | 需要准备 |
|---|---|---|
| Codex | `codex exec --json`，在 Codex 自己的系统沙箱里运行 | `npm install -g @openai/codex`，然后 `codex login` |
| Claude Code | `claude` 无界面模式（`--print --output-format stream-json`） | 装了 Claude 桌面版会自动找到它自带的 CLI；或者 `irm https://claude.ai/install.ps1 \| iex` |
| Antigravity | `agy` 无界面模式 | `irm https://antigravity.google/cli/install.ps1 \| iex`，再运行一次 `agy` 登录 |
| OpenClaw | 通过本机 OpenClaw Gateway 调用 `openclaw agent` | `npm install -g openclaw`，Gateway 在运行 |
| Ark CLI | `arkcli +chat`（火山方舟 / 豆包） | `npm install -g @volcengine/ark-cli@latest`，然后 `arkcli auth login` |
| Ollama | 直连本机 Ollama 接口 `127.0.0.1:11434` | 装好 [Ollama](https://ollama.com/download) 并拉取至少一个模型 |
| 推荐 API 中转站 | OpenAI 兼容接口 `https://tokenezgo.com/v1` | 到 [TokenEZGO](https://tokenezgo.com) 获取 API Key |
| Doubao | 火山方舟 OpenAI 兼容 API | 火山方舟 API Key |
| Hermes | 本机任意 OpenAI 兼容服务（vLLM、LM Studio、llama.cpp 等） | 服务在运行，默认 `http://127.0.0.1:8000` |
| 自定义 | 你自己的 OpenAI 兼容 API 或命令行工具 | 在 Agent 页面添加 |

每个 Agent 的配置页都有诊断面板和带"复制命令"的安装向导。所有配置都在 `.env` 里（`.env.example` 列出了全部选项），也可以直接在界面里改。

## 权限等级

| 档位 | 行为 |
|---|---|
| 请求批准（默认） | Xgent Hub 判断有风险的操作都会进审批队列；Claude Code 每次调用工具前都会问。 |
| 帮我批准 | 只有高风险操作会问。Codex 加 `--approve-for-me`，Claude Code 用 `--permission-mode auto`。 |
| 完全访问 | 不拦截任何操作，Codex 以 `danger-full-access` 运行。只在完全信任这条指令时使用。 |

## 安全

- 服务默认只监听 `127.0.0.1`。要让局域网访问，需要在 `.env` 里同时设置 `HOST` 和 `ALLOW_LAN_BIND=true`。
- 登录用 `.env` 里的 `ADMIN_TOKEN`，登录后发一个 HttpOnly 会话 Cookie。`ADMIN_TOKEN` 为空时服务不需要登录就能用，所以请保持它有值。
- 不要把端口直接暴露到公网。在外面用，推荐 [Tailscale](https://tailscale.com/)（电脑和手机登录同一个账号，然后打开 `http://<Tailscale IP>:4180`），或者前面带身份验证的隧道。
- Agent 以你当前 Windows 用户的权限在本机运行。批准操作前看清楚，尤其是完全访问模式。

## 日常使用

| 脚本 | 作用 |
|---|---|
| `start-app.bat` | 打开桌面版 |
| `start-prod.bat` / `restart-prod.bat` / `stop.bat` | 启动 / 重启 / 停止后台服务 |
| `status-prod.bat` | 查看服务状态、端口和日志位置 |
| `doctor.bat` | 自检 Node、依赖、配置和已装的 CLI |
| `export-config.bat` / `import-config.bat` | 把配置迁移到另一台电脑（默认不带密钥） |
| `scripts/restore-data.ps1` | 列出或恢复 `backups/data` 里的自动数据库备份 |

日志在 `logs/`，按月归档，保留一年。

## 开发

```bash
npm install
copy .env.example .env    # 设置 ADMIN_TOKEN
npm run dev               # 后端 :4180，Vite 开发服务器 :5180
npm test                  # 后端测试（node --test）
npm run build             # 后端类型检查 + 构建前端
```

在 `.env` 里设 `AGENTHUB_ENABLE_MOCK=1` 会显示 Mock Agent：不调用任何模型，模拟一整个任务流程（计划、改文件、Diff、审批），方便调界面。跑测试时会自动打开。

目录结构：

```
server/   Fastify + TypeScript 后端，SQLite 存储，SSE 实时推送，各 Agent 的 adapter
web/      React + Vite 前端
desktop/  Electron 桌面壳
scripts/  Windows 服务、安装、备份和自检脚本
```

接入新的 Agent：在 `server/src/adapters/` 下新建文件实现 `AgentAdapter` 接口（`server/src/adapters/types.ts`），在 `server/src/adapters/registry.ts` 里注册；需要新配置项就加到 `server/src/config.ts` 和 `.env.example`。任务管理、路由和前端只依赖这个接口，不用改。

## 许可证

Xgent Hub 采用双许可：

- **开源许可：[GNU AGPL-3.0](LICENSE)。** 个人和企业都可以免费使用、修改和分发。但如果你修改了代码，并通过网络向他人提供服务，或者分发修改后的版本，就必须以 AGPL-3.0 公开你的全部修改源码。
- **商业许可。** 如果你想在闭源产品或服务里使用、修改 Xgent Hub，不想公开自己的源码，需要购买商业许可，请发邮件联系作者：expectaly@gmail.com。

向本仓库提交代码（Pull Request）即表示你同意作者可以同时以 AGPL-3.0 和商业许可发布你贡献的代码。
