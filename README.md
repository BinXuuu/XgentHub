# Xgent Hub

[English](README.en.md) | 中文

Xgent Hub 是一个本机 Agent 控制台，把你电脑上装的 coding agent 放到同一个网页工作台里统一使用：Codex、Claude Code、Antigravity、OpenClaw、Ark CLI、Ollama，以及任何 OpenAI 兼容 API。可以用桌面版、浏览器或手机打开。核心是任务看板、审批队列和 Diff 审阅，而不是一个"模型下拉框 + 聊天框"。

> 目前只支持 Windows 10 / 11：服务脚本、安装器和调用 CLI 的方式都是按 Windows 写的。

## 截图

**工作台**：所有任务的状态、需要你处理的事、各个 Agent 能不能用，一眼看清。

![工作台](.github/screenshots/dashboard.png)

**审批**：Claude Code 要改文件前先停下来等你批准，可以允许一次、总是允许或拒绝。

![审批弹窗](.github/screenshots/approval.png)

**Diff 审阅**：这一轮 Agent 改了哪些文件、每一行怎么改的，验收通过还是要求修改。

![Diff 审阅](.github/screenshots/diff.png)

**多 Agent 并行**：一个需求拆成几个子任务，分给 Codex、Claude Code、Antigravity 等不同 Agent 同时做；有先后关系的自动排队，全部完成后交回总管家汇总。流动的虚线表示正在运行。

![多 Agent 并行流程](.github/screenshots/flow.png)

**汇总结果**：每个子任务的回复都标明来自哪个子任务、哪个 Agent，最后由总管家核对整个工作区，把结果整理好交给你。

![汇总结果](.github/screenshots/summary.png)

**聊天**：不需要工作区的轻量对话，可以选任意 Agent 和模型连续聊。

![聊天](.github/screenshots/chat.png)

## 功能

- **任务**：让 Agent 在指定的工作区文件夹里干活，实时看到它的消息、终端输出、文件改动和 Diff。可以中途停止、继续对话，或者把任务转交给另一个 Agent 和模型。
- **审批队列**：装依赖、跑命令、`git push`、碰密钥文件这类有风险的操作会先等你批准。Claude Code 自己每次调用工具前的确认也会进同一个队列。有待审批时会弹窗、响提示音、改标签页标题、在导航上显示数字。
- **每个任务三档权限**：请求批准、帮我批准（只有高风险操作问你）、完全访问。
- **撤回**：Agent 每一轮改动前都会存快照，可以把工作区退回到某一轮之前。
- **AI 智能拆分 + 并行执行**：描述一个大一点的需求，让它拆成多个子任务分给不同的 Agent 和模型。互不依赖的子任务同时跑，有先后关系的自动排队，全部完成后交回总管家汇总；用流程图跟进进度。`.env` 里的 `AGENTHUB_MAX_PARALLEL_SUBTASKS` 可以限制同时跑几个（默认不限）。
- **聊天**：不需要工作区的轻量对话，可以选任意 Agent。
- **角色**：把一个 Agent + 模型包装成固定身份（比如"美工""文案"），带自己的说明和知识库。
- **知识库、Skill、工具和 MCP**：统一管理一次，再挂到工作区、聊天或角色上。
- **Agent 诊断**：每个 Agent 的配置页会检查 CLI 装没装、登没登录，列出模型和用量，并给出一步步的安装说明。
- **桌面版**：Electron 桌面壳，会自动拉起本地服务并自动登录。
- **手机访问**：在局域网或 Tailscale 里用手机打开。
- **数据安全**：启动时和每 24 小时自动备份数据库，附带恢复脚本。

## Agent

Agent 就是真正干活的 AI。Xgent 不自己写代码，而是把任务交给你已经在用的 Agent，并把它们统一管起来：

- **本机命令行 Agent**：Codex、Claude Code、Antigravity、OpenClaw、Ark CLI。它们在你的电脑上直接读写工作区里的文件、跑命令。
- **API 类 Agent**：推荐 API 中转站、豆包、Hermes、本机 Ollama，以及任何 OpenAI 兼容接口，适合聊天和不需要改文件的任务。
- **自定义 Agent**：接入你自己的 API 或命令行工具。

左边的 Agent 列表里，每个 Agent 后面都标着当前登录的账号，点「剩余用量」可以直接看额度。点进去是它的详情页：

- **账号**：显示登录的是哪个账号、什么套餐。Codex 和 Claude Code 可以添加多个账号，每个账号有独立的登录、额度和会话记录，新建任务时像选 Agent 一样选它；Claude Code 账号还可以改用官方 API Key 或你自己的中转站。登录按钮会弹出登录窗口（macOS 打开「终端」，NAS 上给出登录命令）。
- **自动探测**：检查命令行装没装、登没登录、版本是不是最新、有哪些模型、还剩多少额度，有问题会给出带「复制命令」的修复步骤。
- **配置**：命令路径、沙箱模式、默认模型等，改完马上生效，不用手动编辑 `.env`。

还可以把一个 Agent 包装成**角色**（比如「美工」「文案」），带上固定的说明、默认模型、知识库、MCP、工具和 Skill，用起来就像一个新的 Agent。

![Agent 列表和 Codex 详情：账号、额度、自动探测](.github/screenshots/agents.png)

![Claude Code 的第二个账号：走中转站](.github/screenshots/agent-accounts.png)

## 工作区

工作区就是一个项目文件夹。每个任务都属于一个工作区，Agent 在这个文件夹里干活，改动也只记在这里：

- **上下文**：写下项目背景、技术约束、注意事项（比如「不引入框架」「改完要自测」），每一轮都会自动带给 Agent，不用每次在任务里重复。
- **允许访问空间**：除了项目文件夹，还可以给 Agent 开放别的目录，比如设计素材、网络盘上的备份目录。
- **可用资源**：勾选这个工作区要用的知识组、MCP、工具和 Skill，对里面所有任务生效。知识库、MCP 这些在左侧统一管理一次，多个工作区可以共用。
- **快照和撤回**：Agent 每一轮改文件前都会给工作区拍快照，「文件 / Diff」页能看到这一轮改了什么，不满意可以退回到这一轮之前。
- **可用 Agent**：可以限制这个工作区只让哪几类 Agent 干活。

Docker 版里，工作区路径要填容器里的路径，比如 `/workspaces/my-project`（见下面的 Docker 安装说明）。

![工作区：项目路径、允许访问空间、上下文](.github/screenshots/workspace.png)

![工作区的可用资源：知识组、MCP、工具、Skill](.github/screenshots/workspace-resources.png)

## 环境要求

- Windows 10 / 11、macOS（Apple 芯片和 Intel 都行）或 Linux；NAS（飞牛 fnOS、群晖等）推荐用 Docker 版
- [Node.js](https://nodejs.org/) 22.13 或更新版本（用到内置的 `node:sqlite` 和 TypeScript 类型擦除）；Docker 版不需要
- 至少一个 Agent：比如 Codex、Claude Code 这类 CLI，本机的 Ollama，或者一个 OpenAI 兼容服务的 API Key

## 安装（Windows）

```bash
git clone <本仓库地址> XgentHub
cd XgentHub
install.bat
```

`install.bat` 会从 `.env.example` 生成 `.env` 并随机生成登录令牌 `ADMIN_TOKEN`，然后运行 `npm install`、`npm run build`，最后跑一遍自检（`xgent.bat doctor`）。

可选参数（创建快捷方式、开机启动、装完直接启动）：

```bash
install.bat -InstallShortcuts -InstallStartupTask -StartAfterInstall
```

启动方式：

- `start-app.bat`：打开桌面版。服务没启动会自动拉起，并用 `.env` 里的令牌自动登录。
- `xgent.bat start`：只启动后台服务。浏览器打开 `http://127.0.0.1:4180`，用 `.env` 里 `ADMIN_TOKEN=` 后面那串登录。

第一次打开会进入配置中心向导：环境自检、本机发现（找到已装的 CLI 并把路径写进 `.env`）、添加 Agent、开机启动、创建测试任务。默认工作区会建在 `%USERPROFILE%\XgentHub-Workspace`。

## 安装（macOS / Linux）

```bash
git clone <本仓库地址> XgentHub
cd XgentHub
bash install.sh --service
```

`install.sh` 会生成 `.env` 和随机登录令牌，运行 `npm ci`、`npm run build`。加 `--service` 会装上开机自启并马上启动：macOS 用 launchd（登录后自动运行，崩溃自动拉起），Linux 用 systemd 用户服务。不想开机自启就用 `--start`，只在后台启动这一次。

装好后浏览器打开 `http://127.0.0.1:4180`，用 `.env` 里 `ADMIN_TOKEN=` 后面那串登录。日常管理：

```bash
bash scripts/xgent.sh status     # 状态
bash scripts/xgent.sh restart    # 重启（start / stop 同理）
bash scripts/xgent.sh logs       # 看日志
bash scripts/service.sh uninstall  # 取消开机自启
```

- macOS 上装了 Claude 桌面版的话，会自动找到它自带的 Claude Code，不用另装。
- Linux 服务器想在没登录时也自动运行，再执行一次 `sudo loginctl enable-linger $USER`。
- 在线更新和 Windows 一样，点左下角的版本号；失败会自动恢复原版本。
- 桌面版（Electron）、自检、导入导出配置目前只有 Windows 版，macOS / Linux 用浏览器访问。

## 安装（Docker：NAS / Linux 服务器）

适合飞牛 fnOS、群晖这类 NAS，或者没有图形界面的 Linux 服务器。镜像里已经装好了 Node.js、git、Codex CLI 和 Claude Code CLI。

```bash
git clone <本仓库地址> XgentHub
cd XgentHub
docker compose up -d --build
docker compose logs xgent   # 第一次启动会在这里打印自动生成的登录令牌
```

浏览器打开 `http://<NAS 的 IP>:4180`。数据都在 `docker-compose.yml` 旁边的 `xgent-data/` 里：`data/` 是数据库和配置（令牌在 `data/admin-token`），`home/` 是 Codex、Claude Code 的登录信息。

- **项目文件夹**：把 NAS 上的共享文件夹挂到容器的 `/workspaces` 下面（改 `docker-compose.yml` 里的 `volumes`），在 Xgent 里添加工作区时填容器里的路径，比如 `/workspaces/my-project`。
- **登录 Agent**：NAS 没有屏幕弹不出登录窗口。在 Agent 详情页点「登录」会给出要运行的命令，比如 `docker exec -it -u node xgenthub codex login --device-auth`：在 NAS 的终端里运行，用手机或电脑打开它给的网址、输入验证码就登录好了。也可以用 API Key 登录。
- **需要代理**：在 `docker-compose.yml` 里填 `HTTPS_PROXY`。
- **更新**：`git pull && docker compose up -d --build`，数据不受影响。程序里的在线更新按钮在 Docker 版里不可用。

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

Windows 上根目录只有三个要用的文件：`install.bat`（安装）、`start-app.bat`（打开桌面版），其它都交给 `xgent.bat`（跟 macOS / Linux 的 `scripts/xgent.sh` 用法一样）：

| 命令 | 作用 |
|---|---|
| `xgent.bat start` / `restart` / `stop` | 启动 / 重启 / 停止后台服务 |
| `xgent.bat status` | 查看服务状态、端口和日志位置 |
| `xgent.bat logs` | 看最近的日志（`logs -f` 持续跟踪） |
| `xgent.bat doctor` | 自检 Node、依赖、配置和已装的 CLI |
| `xgent.bat autostart on` / `off` | 登录 Windows 后自动在后台启动 |
| `xgent.bat shortcuts install` / `remove` | 创建 / 删除桌面和开始菜单快捷方式 |
| `xgent.bat export-config` / `import-config` | 把配置迁移到另一台电脑（默认不带密钥） |
| `scripts/restore-data.ps1` | 列出或恢复 `backups/data` 里的自动数据库备份 |

`xgent.bat help` 列出全部命令；直接双击 `xgent.bat` 也会显示这份帮助。

日志在 `logs/`，按月归档，保留一年。

## 自己打包安装程序

本仓库不提供现成的安装包，需要的话可以自己打一个 `.exe`，拿到别的电脑上安装：

1. 先按上面的「安装」在本机跑通一次 `install.bat`。
2. 安装 [NSIS 3](https://nsis.sourceforge.io/Download)（默认装到 `C:\Program Files (x86)\NSIS` 就能自动找到；装在别处的话运行 `npm run installer:nsis -- -MakensisPath <makensis.exe 的完整路径>`）。
3. 在项目目录运行：

   ```bash
   npm run installer:nsis
   ```

   它会先构建并做发布检查（确认安装包里没有 `.env`、数据库、日志、`server/data` 等本机私有文件），再打包。
4. 生成的安装程序在 `backups\XgentHub-setup-nsis-<日期时间>.exe`。

需要注意：

- 安装程序里只有程序本身，不带 `node_modules`。目标电脑需要先装好 Node.js 22.13+，安装过程中会联网执行 `npm install`。
- 安装程序没有数字签名，Windows 可能弹出「已保护你的电脑」，点「更多信息 → 仍要运行」即可。
- 默认装到 `%LOCALAPPDATA%\Programs\Xgent Hub`，不需要管理员权限；卸载时可以选择保留配置和数据。
- 没装 NSIS 时脚本不会报错退出，只会生成发布压缩包和一份编译命令，装好 NSIS 后再执行那份命令即可。

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
scripts/  服务管理、安装、更新、备份和自检脚本（Windows 专用的在 scripts/windows/）
```

接入新的 Agent：在 `server/src/adapters/` 下新建文件实现 `AgentAdapter` 接口（`server/src/adapters/types.ts`），在 `server/src/adapters/registry.ts` 里注册；需要新配置项就加到 `server/src/config.ts` 和 `.env.example`。任务管理、路由和前端只依赖这个接口，不用改。

## 许可证

Xgent Hub 采用双许可：

- **开源许可：[GNU AGPL-3.0](LICENSE)。** 个人和企业都可以免费使用、修改和分发。但如果你修改了代码，并通过网络向他人提供服务，或者分发修改后的版本，就必须以 AGPL-3.0 公开你的全部修改源码。
- **商业许可。** 如果你想在闭源产品或服务里使用、修改 Xgent Hub，不想公开自己的源码，需要购买商业许可，请发邮件联系作者：expectaly@gmail.com。

向本仓库提交代码（Pull Request）即表示你同意作者可以同时以 AGPL-3.0 和商业许可发布你贡献的代码。
