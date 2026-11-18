import crypto from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { buildZip, type ZipFileSpec } from "./zipBuilder.ts";

// 本机假商店：按 Xgent 和官网约定的 /api/xgent/v1 接口实现，测试和页面演示都用它。
// 只有一个账号；授权页和结算页是两个带按钮的简单网页，点按钮就是「确认授权」「模拟付款」。

export interface MockSkill {
  id: string;
  group: string;
  version: string;
  name: string;
  summary: string;
  tags?: string[];
  license?: string;
  priceCents: number;
  /** zip 里的文件；不写就生成一个 <id>/SKILL.md。 */
  zip?: ZipFileSpec[];
  /** 下载接口故意给错的 sha256。 */
  badSha?: boolean;
}

export interface MockStore {
  origin: string;
  base: string;
  skills: Map<string, MockSkill>;
  purchases: Set<string>;
  approveLogin(): void;
  denyLogin(): void;
  pay(ids: string[]): void;
  revokeTokens(): void;
  /** 像真官网一样：免费 Skill 加入「我的库」后不再出现在目录里（Xgent 要靠已购记录补上）。 */
  hideOwnedFree: boolean;
  /** 商店的 MCP / 工具（目录文件格式的条目）。listed 为 false 的不进 /catalog，只能在官网加入「我的库」。 */
  extensions: Map<string, { listed: boolean; item: Record<string, unknown> }>;
  /** 在官网加入「我的库」的 MCP / 工具 id。 */
  savedExtensions: Set<string>;
  /** 有没有 GET /library（老商店只有 /purchases）。 */
  libraryApi: boolean;
  requests: string[];
  close(): Promise<void>;
}

export const DEMO_SKILLS: MockSkill[] = [
  { id: "weekly-report", group: "office", version: "1.0.0", name: "周报生成", summary: "根据本周的提交、任务和聊天记录整理成一份周报。", tags: ["办公", "写作"], license: "商用授权", priceCents: 990 },
  { id: "code-review-checklist", group: "dev", version: "1.2.0", name: "代码审查清单", summary: "按团队约定逐项检查改动：命名、错误处理、测试、安全。", tags: ["开发"], license: "商用授权", priceCents: 1500 },
  { id: "api-doc-writer", group: "dev", version: "0.9.0", name: "接口文档整理", summary: "读路由和类型定义，生成接口文档和调用示例。", tags: ["开发", "文档"], license: "商用授权", priceCents: 1200 },
];

function skillZip(skill: MockSkill): Buffer {
  return buildZip(skill.zip ?? [
    { name: `${skill.id}/` },
    { name: `${skill.id}/SKILL.md`, data: `---\nname: ${skill.name}\ndescription: ${skill.summary}\n---\n# ${skill.name}\n\n版本 ${skill.version}\n` },
    { name: `${skill.id}/templates/example.md`, data: `示例模板（${skill.version}）\n` },
  ]);
}

const page = (title: string, body: string) => `<!doctype html><meta charset="utf-8"><title>${title}</title>
<body style="font-family:sans-serif;max-width:480px;margin:60px auto;line-height:1.6">${body}</body>`;

export async function startMockStore(options: { port?: number; skills?: MockSkill[] } = {}): Promise<MockStore> {
  const skills = new Map((options.skills ?? DEMO_SKILLS).map((skill) => [skill.id, { ...skill }]));
  const purchases = new Set<string>();
  const tokens = new Set<string>();
  const devices = new Map<string, { userCode: string; status: "pending" | "approved" | "denied"; token: string | null }>();
  const requests: string[] = [];
  let origin = "";

  const latestDevice = () => [...devices.values()].at(-1);
  const skillItem = (skill: MockSkill, owned: boolean) => ({
    id: skill.id, kind: "skill", group: skill.group, version: skill.version, name: skill.name, summary: skill.summary, tags: skill.tags ?? [],
    license: skill.license, priceCents: skill.priceCents, currency: "CNY", owned: owned && purchases.has(skill.id), updatedAt: "2026-11-01", detailUrl: `${origin}/skills/${skill.id}`,
  });

  const store: MockStore = {
    origin: "", base: "", skills, purchases, requests, hideOwnedFree: false, extensions: new Map(), savedExtensions: new Set(), libraryApi: false,
    approveLogin() { const device = latestDevice(); if (device) { device.status = "approved"; device.token = `tok-${crypto.randomUUID()}`; tokens.add(device.token); } },
    denyLogin() { const device = latestDevice(); if (device) device.status = "denied"; },
    pay(ids) { for (const id of ids) if (skills.has(id)) purchases.add(id); },
    revokeTokens() { tokens.clear(); },
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url!, "http://x");
    requests.push(`${req.method} ${url.pathname}${url.search}`);
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const raw = Buffer.concat(chunks).toString("utf8");
    let body: Record<string, unknown> = {};
    try { body = raw && req.headers["content-type"]?.includes("json") ? JSON.parse(raw) : Object.fromEntries(new URLSearchParams(raw)); } catch { /* 空 */ }
    const json = (status: number, data: unknown) => { res.writeHead(status, { "content-type": "application/json; charset=utf-8" }); res.end(JSON.stringify(data)); };
    const html = (text: string) => { res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); res.end(text); };
    const token = req.headers.authorization?.replace(/^Bearer\s+/i, "") ?? "";
    const authed = tokens.has(token);
    const needAuth = () => json(401, { error: "unauthorized", message: "请先登录" });
    const api = url.pathname.replace(/^\/api\/xgent\/v1/, "");
    const isApi = url.pathname.startsWith("/api/xgent/v1/");

    if (isApi && api === "/device/code" && req.method === "POST") {
      const deviceCode = crypto.randomUUID();
      const userCode = `${crypto.randomBytes(2).toString("hex")}-${crypto.randomBytes(2).toString("hex")}`.toUpperCase();
      devices.set(deviceCode, { userCode, status: "pending", token: null });
      return json(200, { device_code: deviceCode, user_code: userCode, verification_uri: `${origin}/device`, verification_uri_complete: `${origin}/device?code=${userCode}`, expires_in: 600, interval: 1 });
    }
    if (isApi && api === "/device/token" && req.method === "POST") {
      const device = devices.get(String(body.device_code ?? ""));
      if (!device) return json(400, { error: "expired_token", message: "设备码无效或已过期" });
      if (device.status === "pending") return json(400, { error: "authorization_pending", message: "等待用户确认" });
      if (device.status === "denied") return json(400, { error: "access_denied", message: "用户拒绝了授权" });
      return json(200, { access_token: device.token, account: { id: "u1", email: "you@example.com", displayName: "演示用户" } });
    }
    if (isApi && api === "/catalog" && req.method === "GET") {
      // 不带令牌可以看；带了无效令牌返回 401，客户端据此提示重新连接。
      if (token && !authed) return needAuth();
      return json(200, {
        version: 1, name: "Xgent 商店（演示）", description: "本机假商店", updatedAt: "2026-11-01", url: `${origin}/skills`,
        groups: [
          { id: "office", name: "办公效率", description: "写周报、整理会议纪要", url: `${origin}/skills?group=office` },
          { id: "dev", name: "开发工具", description: "审查、文档", url: `${origin}/skills?group=dev` },
        ],
        items: [
          ...[...skills.values()].filter((skill) => !(store.hideOwnedFree && skill.priceCents === 0 && authed && purchases.has(skill.id))).map((skill) => skillItem(skill, authed)),
          ...[...store.extensions.values()].filter((entry) => entry.listed).map((entry) => entry.item),
        ],
      });
    }
    if (isApi && api === "/library" && req.method === "GET" && store.libraryApi) {
      if (!authed) return needAuth();
      return json(200, {
        items: [
          ...[...purchases].map((id) => skills.get(id)).filter((skill): skill is MockSkill => Boolean(skill)).map((skill) => skillItem(skill, true)),
          ...[...store.savedExtensions].map((id) => store.extensions.get(id)?.item).filter(Boolean),
        ],
      });
    }
    if (isApi && api === "/checkout-url" && req.method === "GET") {
      if (!authed) return needAuth();
      return json(200, { url: `${origin}/checkout?items=${encodeURIComponent(url.searchParams.get("items") ?? "")}&from=xgent` });
    }
    if (isApi && api === "/purchases" && req.method === "GET") {
      if (!authed) return needAuth();
      return json(200, { items: [...purchases].map((id) => ({ skillId: id, version: skills.get(id)?.version ?? "", purchasedAt: "2026-11-01T00:00:00Z" })) });
    }
    const download = /^\/skills\/([^/]+)\/download$/.exec(api);
    if (isApi && download && req.method === "POST") {
      if (!authed) return needAuth();
      const skill = skills.get(decodeURIComponent(download[1]!));
      if (!skill || !purchases.has(skill.id)) return json(403, { error: "not_purchased", message: "还没购买这个 Skill" });
      const zip = skillZip(skill);
      const sha256 = skill.badSha ? "0".repeat(64) : crypto.createHash("sha256").update(zip).digest("hex");
      return json(200, { url: `${origin}/files/${skill.id}-${skill.version}.zip?sig=demo`, sha256, size: zip.length, version: skill.version, fileName: `${skill.id}-${skill.version}.zip` });
    }
    const file = /^\/files\/(.+)-([^-]+)\.zip$/.exec(url.pathname);
    if (file && url.searchParams.get("sig") === "demo") {
      const skill = skills.get(file[1]!);
      if (!skill) { res.writeHead(404); res.end(); return; }
      if (req.headers.authorization) { res.writeHead(400); res.end("signed url must not carry a token"); return; }
      const zip = skillZip(skill);
      res.writeHead(200, { "content-type": "application/zip", "content-length": zip.length });
      res.end(zip);
      return;
    }
    // 演示用网页：授权页和结算页。
    if (url.pathname === "/device" && req.method === "GET") {
      return html(page("授权 Xgent", `<h2>Xgent 请求访问你的 Skill 库</h2><p>授权码：<b>${url.searchParams.get("code") ?? ""}</b></p>
        <form method="post" action="/device/approve"><button style="font-size:16px;padding:8px 20px">确认授权</button></form>`));
    }
    if (url.pathname === "/device/approve" && req.method === "POST") { store.approveLogin(); return html(page("已授权", "<h2>已授权，可以回到 Xgent 了</h2>")); }
    if (url.pathname === "/checkout" && req.method === "GET") {
      const ids = (url.searchParams.get("items") ?? "").split(",").filter((id) => skills.has(id));
      const total = ids.reduce((sum, id) => sum + skills.get(id)!.priceCents, 0);
      return html(page("结算", `<h2>结算（演示）</h2><ul>${ids.map((id) => `<li>${skills.get(id)!.name} ¥${(skills.get(id)!.priceCents / 100).toFixed(2)}</li>`).join("")}</ul>
        <p>合计 ¥${(total / 100).toFixed(2)}</p><form method="post" action="/checkout/pay"><input type="hidden" name="items" value="${ids.join(",")}"><button style="font-size:16px;padding:8px 20px">模拟付款</button></form>`));
    }
    if (url.pathname === "/checkout/pay" && req.method === "POST") {
      store.pay(String(body.items ?? "").split(",").filter(Boolean));
      return html(page("付款成功", "<h2>付款成功，Xgent 会自动安装</h2>"));
    }
    json(404, { error: "not_found", message: "没有这个接口" });
  });
  await new Promise<void>((resolve) => server.listen(options.port ?? 0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  store.origin = origin;
  store.base = `${origin}/api/xgent/v1`;
  return store;
}
