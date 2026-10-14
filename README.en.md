# Xgent Hub

English | [中文](README.md)

Xgent Hub is a local control console for the coding agents installed on your computer: Codex, Claude Code, Antigravity, OpenClaw, Ark CLI, Ollama and any OpenAI-compatible API. You drive all of them from one web workspace (desktop app, browser or phone). The core is a task board with an approval queue and diff review, not a model dropdown with a chat box.

> The user interface is currently in Simplified Chinese. Windows 10/11 is the only supported platform: the service scripts, installer and CLI launching are Windows-specific.

## Features

- **Tasks**: give an agent a job in a workspace folder and follow its messages, terminal output, file changes and diffs live. Stop it, continue the conversation, or hand the task over to another agent and model mid-way.
- **Approval queue**: risky actions (installing packages, running commands, `git push`, touching secrets) wait for your approval. Claude Code's own per-tool permission prompts appear in the same queue. A pop-up, sound, tab title and badge tell you when something is waiting.
- **Three permission levels per task**: ask for approval, approve for me (only high-risk actions ask), or full access.
- **Undo**: every agent turn is snapshotted, so you can roll a workspace back to before a turn.
- **AI task splitting**: describe a larger job and let a planner split it into subtasks assigned to different agents and models, then follow it as a flow graph.
- **Chat**: lightweight conversations with any agent, without a workspace.
- **Roles**: wrap an agent and model into a fixed persona ("designer", "copywriter") with its own instructions and knowledge.
- **Knowledge base, Skills, tools and MCP servers**: manage them once and attach them to workspaces, chats or roles.
- **Agent diagnostics**: each agent's page checks whether its CLI is installed and logged in, lists models and usage, and gives step-by-step install instructions.
- **Desktop app**: an Electron shell that starts the local service and logs in automatically.
- **Phone access**: use it from your phone over the LAN or Tailscale.
- **Data safety**: automatic database backups at startup and every 24 hours, with a restore script.

## Requirements

- Windows 10 or 11
- [Node.js](https://nodejs.org/) 22.5 or newer (uses the built-in `node:sqlite` and TypeScript type stripping)
- At least one agent: a CLI such as Codex or Claude Code, a local Ollama, or an API key for an OpenAI-compatible service

## Install

```bash
git clone <this repository> XgentHub
cd XgentHub
install.bat
```

`install.bat` creates `.env` from `.env.example` with a randomly generated `ADMIN_TOKEN`, runs `npm install` and `npm run build`, then runs the self-check (`doctor.bat`).

Optional switches:

```bash
install.bat -InstallShortcuts -InstallStartupTask -StartAfterInstall
```

Then start it:

- `start-app.bat` opens the desktop app. It starts the service if needed and logs in with the token from `.env` automatically.
- `start-prod.bat` starts only the background service. Open `http://127.0.0.1:4180` and sign in with the `ADMIN_TOKEN` value from `.env`.

On first launch the setup wizard (配置中心) walks you through the self-check, machine discovery (finds installed CLIs and writes their paths into `.env`), adding agents, startup options and a test task. A default workspace is created at `%USERPROFILE%\XgentHub-Workspace`.

## Supported agents

| Agent | How it connects | You need |
|---|---|---|
| Codex | `codex exec --json`, runs inside Codex's own OS sandbox | `npm install -g @openai/codex`, then `codex login` |
| Claude Code | `claude` headless mode (`--print --output-format stream-json`) | Claude Desktop (its bundled CLI is found automatically) or `irm https://claude.ai/install.ps1 \| iex` |
| Antigravity | `agy` headless mode | `irm https://antigravity.google/cli/install.ps1 \| iex`, then run `agy` once to sign in |
| OpenClaw | `openclaw agent` through the local OpenClaw Gateway | `npm install -g openclaw`, gateway running |
| Ark CLI | `arkcli +chat` (Volcengine Ark / Doubao) | `npm install -g @volcengine/ark-cli@latest`, then `arkcli auth login` |
| Ollama | native Ollama API on `127.0.0.1:11434` | [Ollama](https://ollama.com/download) with at least one model pulled |
| Recommended API gateway | OpenAI-compatible API at `https://tokenezgo.com/v1` | an API key from [TokenEZGO](https://tokenezgo.com) |
| Doubao | Volcengine Ark OpenAI-compatible API | an Ark API key |
| Hermes | any local OpenAI-compatible server (vLLM, LM Studio, llama.cpp…) | the server running, default `http://127.0.0.1:8000` |
| Custom | your own OpenAI-compatible API or command-line tool | added from the Agent page |

Every agent's settings page has a diagnostics panel and an install guide with copyable commands. All settings live in `.env` (see `.env.example` for every option) and can also be edited from the UI.

## Permission levels

| Level | Behaviour |
|---|---|
| Ask for approval (default) | Anything Xgent Hub flags as risky waits in the approval queue. Claude Code asks before each tool use. |
| Approve for me | Only high-risk actions ask. Codex gets `--approve-for-me`; Claude Code gets `--permission-mode auto`. |
| Full access | Nothing is intercepted. Codex runs with `danger-full-access`. Only use it for prompts you fully trust. |

## Security

- The service listens on `127.0.0.1` by default. Binding to a LAN address requires `HOST` plus `ALLOW_LAN_BIND=true` in `.env`.
- Sign-in uses `ADMIN_TOKEN` from `.env` and issues an HttpOnly session cookie. If `ADMIN_TOKEN` is empty, the service runs without sign-in, so keep it set.
- Do not expose the port to the internet. For access away from home, use [Tailscale](https://tailscale.com/) (both devices on the same tailnet, then open `http://<tailscale-ip>:4180`) or a tunnel with its own authentication in front.
- Agents run with your user's permissions on your machine. Review what you approve, especially with full access.

## Daily operations

| Script | What it does |
|---|---|
| `start-app.bat` | Open the desktop app |
| `start-prod.bat` / `restart-prod.bat` / `stop.bat` | Start, restart or stop the background service |
| `status-prod.bat` | Show service status, ports and log locations |
| `doctor.bat` | Self-check of Node, dependencies, configuration and installed CLIs |
| `export-config.bat` / `import-config.bat` | Move your configuration to another computer (secrets are redacted unless you ask otherwise) |
| `scripts/restore-data.ps1` | List or restore automatic database backups from `backups/data` |

Logs are written to `logs/`, rotated monthly and kept for a year.

## Development

```bash
npm install
copy .env.example .env    # set ADMIN_TOKEN
npm run dev               # backend on :4180, Vite dev server on :5180
npm test                  # server tests (node --test)
npm run build             # type-check the server and build the web UI
```

Set `AGENTHUB_ENABLE_MOCK=1` in `.env` to show the Mock Agent, which simulates a full task (plan, file edits, diff, approvals) without calling any model. Tests enable it automatically.

Project layout:

```
server/   Fastify + TypeScript backend, SQLite storage, SSE events, agent adapters
web/      React + Vite frontend
desktop/  Electron desktop shell
scripts/  Windows service, install, backup and diagnostics scripts
```

To add a new agent runtime, implement the `AgentAdapter` interface (`server/src/adapters/types.ts`) in a new file under `server/src/adapters/`, register it in `server/src/adapters/registry.ts`, and add any new settings to `server/src/config.ts` and `.env.example`. The task manager, routes and UI only depend on that interface.

## License

Xgent Hub is dual-licensed:

- **Open source: [GNU AGPL-3.0](LICENSE).** Anyone, including companies, may use, modify and distribute it free of charge. If you modify it and offer it to others over a network, or distribute a modified version, you must publish the complete source of your changes under the AGPL-3.0.
- **Commercial license.** To use or modify Xgent Hub in a closed-source product or service without publishing your source code, you need a commercial license. Contact the author at expectaly@gmail.com.

By submitting a contribution (pull request) to this repository, you agree that the author may distribute your contribution under both the AGPL-3.0 and the commercial license.
