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

## 商店订阅源

除了上面这种目录文件，订阅源还可以是一个「商店」：卖 Skill 的网站。在「推荐 → 订阅源」里类型选「商店」，填商店的接口地址（比如 `https://example.com/api/xgent/v1`）。设置了环境变量 `XGENT_STORE_URL` 时会多出一个内置商店。

用户这边的流程：

1. 推荐页顶部点「连接官网账号」，Xgent 显示一个授权码并用浏览器打开商店的授权页，用户在网页上登录、确认，Xgent 自动连上。
2. 勾选想要的 Skill，点「去官网购买」，Xgent 用浏览器打开商店的结算页。
3. 用户在网页上付款。Xgent 在后台每 5 秒查一次已购（最多 15 分钟），发现刚买的就下载安装，页面关了也照样进行。
4. 买过的 Skill 换电脑、重装后点「安装」就能恢复；商店里版本号变了会显示「有更新」。

**Xgent 里没有任何支付代码**，付款、退款、发票都在商店网站上完成。登录令牌只保存在用户自己的电脑上（数据目录的 `catalog-sources.json`），不会显示在页面上。

### 商店要提供的接口

都在商店地址下，返回 JSON；需要登录的带 `Authorization: Bearer <access_token>`，每个请求都带 `X-Xgent-Client: Xgent <版本> (<电脑名>; <系统>)`，商店可以把它显示在「已授权设备」里。出错时返回 `{ "error": "<代码>", "message": "<中文说明>" }`。

| 接口 | 说明 |
|---|---|
| `POST /device/code` | 开始设备授权。返回 `{ device_code, user_code, verification_uri, verification_uri_complete, expires_in, interval }` |
| `POST /device/token` `{ device_code }` | 用户还没确认返回 `{ error: "authorization_pending" }`，过期 `expired_token`，拒绝 `access_denied`，设备码无效或已用过 `invalid_grant`，太频繁 `slow_down`；确认后返回 `{ access_token, account: { id, email, displayName } }` |
| `GET /catalog` | 目录，格式和上面的目录文件一样（`version: 1`、`groups`、`items`），Skill 条目多出 `priceCents`（分）、`currency`、`owned`、`detailUrl`，不带 `source`（从商店下载）；也可以有 `kind: "mcp"` / `"tool"` 条目，格式和上面的目录文件一样（`mcp` / `tool` / `inputs`），免费、直接按配置安装，可带 `detailUrl`；SSE 协议的远程 MCP 和没有安装配置的不要放进来。不带令牌也能看；带了有效令牌就标出 `owned`；**带了无效令牌要返回 401**，Xgent 据此提示重新连接 |
| `GET /checkout-url?items=id1,id2` | 返回 `{ url }`，结算页地址，Xgent 用浏览器打开 |
| `GET /purchases` | 返回 `{ items: [{ skillId, version, purchasedAt }] }`，即用户的「我的库」（买的和免费领取的都算）。Xgent 用它发现新入库的 Skill；目录里没列出的已入库条目也按它补上安装入口 |
| `GET /library`（可选） | 返回 `{ items: [...] }`：用户「我的库」里的全部条目（买的和免费领取的 Skill，加入库的 MCP 和工具），格式同 `/catalog` 的条目，MCP / 工具要带完整配置。不在 `/catalog` 里的（比如几万个社区条目）也照样列出，Xgent 靠它显示名字和安装。没有这个接口时 Xgent 退回用 `/purchases` |
| `POST /skills/:id/download` | 返回 `{ url, sha256, size, version, fileName }`；没买过返回 403 |

推荐页上商店每组只显示前 8 个，其余点「去官网看全部」。`/catalog` 可以多给两个可选字段：根上的 `url`（官网首页，不给就用商店地址的域名）和每个分组的 `url`（这一组在官网上的完整列表）。用户从 Xgent 打开官网后，Xgent 在 15 分钟内盯着 `/purchases`，在官网新加入「我的库」的 Skill 会自动安装。已入库的条目最好在 `/catalog` 里照常列出并标 `owned: true`，不要隐藏，不然 Xgent 只知道 id，显示不出名字。

下载安装包的要求：

- `url` 是签名下载链接，可以在别的域名（比如对象存储），Xgent 下载时**不带**登录令牌。
- 安装包是 zip，最大 50 MB；解开后是一个文件夹，里面有 `SKILL.md`（`SKILL.md` 直接放在根目录也行）。
- Xgent 会校验 `size` 和 `sha256`，拒绝加密、zip64、符号链接、绝对路径和 `..`，单个文件不超过 20 MB、解压后总共不超过 100 MB、最多 500 个文件。
- 装在数据目录 `skills/store/<订阅源>/<Skill id>/`，再登记进技能库；同一个 Skill 再装一次就是更新，用户在技能库里改过的名称、说明和分组会保留。

仓库里的 `server/test/helpers/mockStore.ts` 是按这套接口写的本机假商店，可以对照着实现。

## 收录原则

- 只收开源许可、允许再分发的内容；专有许可的（比如 Anthropic 的 docx / pdf / pptx / xlsx Skill）不要收。
- 不要在目录里写任何密钥；需要密钥的地方用 `inputs` 让用户自己填。
- 改动后在本机用「订阅源 → 添加 → 本机文件路径」预览一遍再发布。格式不对的条目会被跳过并在页面上提示。
