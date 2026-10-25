# Xgent Hub

English | [中文](README.md)

Xgent Hub is a local control console for the coding agents installed on your computer: Codex, Claude Code, Antigravity, OpenClaw, Ark CLI, Ollama and any OpenAI-compatible API. You drive all of them from one web workspace (desktop app, browser or phone). The core is a task board with an approval queue and diff review, not a model dropdown with a chat box.

> The user interface is currently in Simplified Chinese. Windows 10/11 is the only supported platform: the service scripts, installer and CLI launching are Windows-specific.

## Screenshots

**Dashboard**: task status, what needs your attention, and which agents are ready, at a glance.

![Dashboard](.github/screenshots/dashboard.png)

**Approvals**: Claude Code stops before editing a file and waits for you to allow it once, always allow, or deny.

![Approval pop-up](.github/screenshots/approval.png)

**Diff review**: every file the agent changed in this round, line by line, then accept or ask for changes.

![Diff review](.github/screenshots/diff.png)

**Parallel agents**: one request split into subtasks handed to different agents (Codex, Claude Code, Antigravity…) that work at the same time; steps that depend on others wait for them, and everything comes back to the coordinator for a summary. Animated dashed edges are runs in progress.

![Parallel multi-agent flow](.github/screenshots/flow.png)

**Summary**: every subtask's reply is labelled with its subtask and agent; at the end the coordinator checks the whole workspace and hands you the result.

![Summary](.github/screenshots/summary.png)

**Chat**: lightweight conversations with any agent and model, no workspace needed.

![Chat](.github/screenshots/chat.png)

## Features

- **Tasks**: give an agent a job in a workspace folder and follow its messages, terminal output, file changes and diffs live. Stop it, continue the conversation, or hand the task over to another agent and model mid-way.
- **Approval queue**: risky actions (installing packages, running commands, `git push`, touching secrets) wait for your approval. Claude Code's own per-tool permission prompts appear in the same queue. A pop-up, sound, tab title and badge tell you when something is waiting.
- **Three permission levels per task**: ask for approval, approve for me (only high-risk actions ask), or full access.
- **Undo**: every agent turn is snapshotted, so you can roll a workspace back to before a turn.
- **AI task splitting with parallel execution**: describe a larger job and let a planner split it into subtasks assigned to different agents and models. Independent subtasks run at the same time, dependent ones wait, and the coordinator summarizes the results at the end; follow it all as a flow graph. `AGENTHUB_MAX_PARALLEL_SUBTASKS` in `.env` limits how many run at once (unlimited by default).
- **Chat**: lightweight conversations with any agent, without a workspace.
- **Roles**: wrap an agent and model into a fixed persona ("designer", "copywriter") with its own instructions and knowledge.
- **Knowledge base, Skills, tools and MCP servers**: manage them once and attach them to workspaces, chats or roles.
- **Agent diagnostics**: each agent's page checks whether its CLI is installed and logged in, lists models and usage, and gives step-by-step install instructions.
- **Desktop app**: an Electron shell that starts the local service and logs in automatically.
- **Phone access**: use it from your phone over the LAN or Tailscale.
- **Data safety**: automatic database backups at startup and every 24 hours, with a restore script.

## Requirements

- Windows 10 / 11, macOS (Apple silicon or Intel) or Linux; for a NAS (fnOS, Synology, ...) use the Docker image
- [Node.js](https://nodejs.org/) 22.13 or newer (uses the built-in `node:sqlite` and TypeScript type stripping); not needed for Docker
- At least one agent: a CLI such as Codex or Claude Code, a local Ollama, or an API key for an OpenAI-compatible service

## Install (Windows)

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

## Install (macOS / Linux)

```bash
git clone <this repository> XgentHub
cd XgentHub
bash install.sh --service
```

`install.sh` creates `.env` with a random `ADMIN_TOKEN`, runs `npm ci` and `npm run build`. `--service` also sets up auto-start and starts it right away: launchd on macOS (runs after login, restarted if it crashes), a systemd user service on Linux. Use `--start` instead to just start it in the background once.

Open `http://127.0.0.1:4180` and sign in with the `ADMIN_TOKEN` value from `.env`. Day-to-day:

```bash
bash scripts/xgent.sh status       # status
bash scripts/xgent.sh restart      # restart (start / stop likewise)
bash scripts/xgent.sh logs         # follow the log
bash scripts/service.sh uninstall  # remove auto-start
```

- On macOS, if the Claude desktop app is installed, its bundled Claude Code is found automatically.
- On a Linux server, run `sudo loginctl enable-linger $USER` once so the service also runs without a login session.
- Online updates work as on Windows (click the version number at the bottom left); a failed update rolls back automatically.
- The desktop app (Electron), the self-check and config import/export are Windows-only for now; use the browser on macOS / Linux.

## Install (Docker: NAS / Linux server)

For a NAS such as fnOS or Synology, or a headless Linux server. The image ships Node.js, git, the Codex CLI and the Claude Code CLI.

```bash
git clone <this repository> XgentHub
cd XgentHub
docker compose up -d --build
docker compose logs xgent   # the first start prints the generated sign-in token here
```

Open `http://<NAS IP>:4180`. Everything lives in `xgent-data/` next to `docker-compose.yml`: `data/` holds the database and settings (token in `data/admin-token`), `home/` holds the Codex and Claude Code logins.

- **Project folders**: mount your NAS shares under `/workspaces` (edit `volumes` in `docker-compose.yml`) and use the in-container path, e.g. `/workspaces/my-project`, when adding a workspace.
- **Signing in to agents**: there is no screen for a login window. The "Log in" button on the agent page shows the command to run, e.g. `docker exec -it -u node xgenthub codex login --device-auth`; run it in the NAS terminal, open the link it prints on your phone or PC and enter the code. API keys work too.
- **Proxy**: set `HTTPS_PROXY` in `docker-compose.yml`.
- **Updating**: `git pull && docker compose up -d --build`; your data is kept. The in-app update button is not available in the Docker version.

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

## Building an installer

No prebuilt installer is published. To make your own `.exe` for installing on other computers:

1. Get `install.bat` working on this machine first (see Install above).
2. Install [NSIS 3](https://nsis.sourceforge.io/Download). The default location `C:\Program Files (x86)\NSIS` is found automatically; otherwise pass `-MakensisPath <full path to makensis.exe>`.
3. In the project folder, run:

   ```bash
   build-nsis-installer.bat
   ```

   It builds the project and runs a release check (making sure no `.env`, database, logs or `server/data` files are included) before packaging.
4. The installer is written to `backups\XgentHub-setup-nsis-<date-time>.exe`.

Notes:

- The installer contains the program only, without `node_modules`. The target computer needs Node.js 22.13+ and internet access, because setup runs `npm install`.
- The installer is not code-signed, so Windows may show "Windows protected your PC". Choose "More info → Run anyway".
- It installs per user into `%LOCALAPPDATA%\Programs\Xgent Hub` without administrator rights. Uninstalling can keep your configuration and data.
- If NSIS is not installed, the script does not fail: it leaves the release zip and a ready-to-run compile command to use once NSIS is installed.

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
