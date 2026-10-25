# 更新日志

每个版本一节，标题写成 `## v主.次.修订`。程序里的「版本与更新」会显示对应版本这一节的内容。

## v1.1.0

支持 macOS、Linux 和 Docker（NAS），Codex / Claude Code 可以登录多个账号。

- macOS / Linux：`bash install.sh --service` 一键安装并开机自启（macOS 用 launchd，Linux 用 systemd），`scripts/xgent.sh` 管理启停；在线更新和失败回滚跟 Windows 一样
- Docker 版：`docker compose up -d --build`，适合飞牛 fnOS、群晖这类 NAS 和 Linux 服务器；镜像自带 Codex、Claude Code CLI，第一次启动自动生成登录令牌
- 多账号：Codex、Claude Code 可以添加多个账号，各自独立登录、额度和会话；Claude Code 账号可以改用 API Key 或中转站；Antigravity 显示当前登录的账号
- 「登录」按钮：Windows 弹登录窗口，macOS 打开「终端」，Linux / Docker 给出要运行的命令（Codex 用设备码登录，手机上就能完成）
- macOS 上自动找到 Claude 桌面版自带的 Claude Code
- 服务重启后，上次没跑完的任务改成「已停止」并说明原因，不再一直显示运行中
- 配置文件改成安全写入并保留上一版，写坏了自动恢复，不会再出现账号、MCP「全部消失」
- 报错直接显示中文原因（以前常常只看到 Internal Server Error）；工作区文件夹被移走时说清楚，不再误报「找不到 codex」
- 页面某处出错只影响那一块，不会整页白屏；网络断开重连后自动刷新数据
- Node.js 最低版本改为 22.13（低于这个版本启动会失败）
- 依赖升级到已修复安全公告的版本

## v1.0.0

第一个支持在线更新的版本。

- 在线更新：左下角显示当前版本，有新版本时出现红点，点开可以查看更新说明并一键更新；更新失败会自动恢复原来的版本，配置和数据不会动
- AI 智能拆分的子任务真正并行执行，全部完成后交回总管家汇总；后面的子任务会自动收到它所依赖的子任务的结果
- 确认、提示弹窗换成应用内的样式，跟随亮色 / 暗色主题
- Claude Code、Antigravity、OpenClaw 任务的「文件 / Diff」页能看到改动
- Claude Code 登录过期时配置页会标红并给出登录命令
- Codex 额度快照不再停在旧日期
- 对话里 Agent 的回复按 Markdown 显示（标题、列表、代码、表格）
- 流程图：跨列连线不再从节点底下穿过，总管家并进任务节点，节点显示 Agent 名称和实际使用的模型
- Codex 配置里的默认模型被下架时，自动改用当前可用的第一个模型
- 依赖更新到已修复安全漏洞的版本
