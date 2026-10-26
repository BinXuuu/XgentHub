# 推荐目录（订阅源）格式

Xgent 左侧「推荐」页读取订阅源里的目录文件，列出整理好的 Skill、MCP 和工具，用户一键安装或更新。

- 内置的「Xgent 官方推荐」读这个仓库 `main` 分支上的 [`catalog.json`](catalog.json)。连不上 GitHub 时用随程序附带的同一个文件，所以离线也能浏览（安装 Skill 仍要能访问 GitHub）。
- 用户可以在「推荐 → 订阅源」里加别的目录：一个 `https://…/catalog.json` 地址，或者本机文件路径（写自己的目录时方便预览）。
- 订阅源可以带访问密钥，读取时放在请求头 `Authorization: Bearer <密钥>` 里，服务端据此决定给不给看，可以用来做只给会员看的目录。密钥只保存在用户自己的电脑上。

## 文件结构

```json
{
  "version": 1,
  "name": "目录名称",
  "description": "一句话介绍",
  "updatedAt": "2026-10-26",
  "groups": [
    { "id": "my-group", "name": "分组名称", "description": "分组说明" }
  ],
  "items": [ ... ]
}
```

每个条目都有：

| 字段 | 说明 |
|---|---|
| `id` | 唯一标识，字母、数字、`_ . -`。发布后不要改，改了会被当成新条目 |
| `kind` | `skill`、`mcp` 或 `tool` |
| `group` | 所属分组的 `id` |
| `version` | 版本号（任意字符串）。**内容有改动时改一下它**，用户那边就会显示「有更新」 |
| `name` | 名称，安装后就是 Skill / MCP / 工具的名字 |
| `summary` | 一两句中文介绍 |
| `tags` | 标签，可选 |
| `license` | 许可证，可选，会显示在卡片上 |

### Skill

从 GitHub 公开仓库下载整个 Skill 目录（含 `SKILL.md` 和配套文件），不运行里面的脚本。

```json
{
  "id": "anthropic-frontend-design", "kind": "skill", "group": "anthropic-skills", "version": "1",
  "name": "frontend-design", "summary": "……", "license": "Apache-2.0",
  "source": { "type": "github", "repo": "anthropics/skills", "ref": "main", "path": "skills/frontend-design" }
}
```

`ref` 是分支、标签或提交，不写就是默认分支。同一个 Skill 再装一次就是更新到 `ref` 的最新内容；用户在技能库里改过的名称、说明和分组会保留。

### MCP

```json
{
  "id": "mcp-filesystem", "kind": "mcp", "group": "mcp-common", "version": "1",
  "name": "filesystem", "summary": "……",
  "mcp": { "transport": "stdio", "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "{{dir}}"] },
  "inputs": [{ "key": "dir", "label": "允许访问的目录", "placeholder": "例如 D:\\Projects", "required": true }]
}
```

- `transport` 为 `stdio` 时写 `command`、`args`、`env`；为 `http` 时写 `url`、`headers`。
- `inputs` 是安装时让用户填的参数，在上面任意字符串里用 `{{key}}` 引用。`secret: true` 的参数（令牌、密钥）显示成密码框，不会回传到页面；更新时留空就沿用上次填的。
- 用户装好后自己改过这个 MCP 的话，更新前会提示「会覆盖你的修改」。

### 工具

```json
{
  "id": "tool-ripgrep", "kind": "tool", "group": "tools-common", "version": "1",
  "name": "ripgrep 代码搜索", "summary": "……",
  "tool": { "content": "给 Agent 看的使用说明", "command": "rg -n \"<关键词>\"" }
}
```

## 收录原则

- 只收开源许可、允许再分发的内容；专有许可的（比如 Anthropic 的 docx / pdf / pptx / xlsx Skill）不要收。
- 不要在目录里写任何密钥；需要密钥的地方用 `inputs` 让用户自己填。
- 改动后在本机用「订阅源 → 添加 → 本机文件路径」预览一遍再发布。格式不对的条目会被跳过并在页面上提示。
