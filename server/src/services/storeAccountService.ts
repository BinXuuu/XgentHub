import { fetchStoreLibrary, forgetStoreTokenOn, getCatalog, getStoreSource, installCatalogItem, invalidateCatalogCache, setStoreCredentials, type StoreAccount } from "./catalogService.ts";
import { StoreApiError, storeRequest } from "./storeSkillService.ts";

// 商店源的「连接官网账号」和「付款后自动安装」。
// 连接用设备授权：向商店要一个设备码 → 用户在浏览器打开授权页登录确认 → 这边后台轮询拿到令牌。
// 结算在官网完成：这边只打开结算页，然后轮询「已购」，发现刚买的就自动安装。都在服务端跑，页面关了也照样进行。
// 「去官网挑选」也一样：打开官网后盯着「我的库」，在官网新加入库（免费领取或购买）的 Skill 自动装到这台电脑。

// XGENT_STORE_POLL_MS 只给测试用，把轮询间隔调短。
const POLL_OVERRIDE_MS = Number(process.env.XGENT_STORE_POLL_MS) || 0;
const LOGIN_POLL_MIN_MS = POLL_OVERRIDE_MS || 2_000;
const WATCH_INTERVAL_MS = POLL_OVERRIDE_MS || 5_000;
const WATCH_DURATION_MS = 15 * 60 * 1000;

export type StoreLoginState = "pending" | "connected" | "expired" | "denied" | "error";

export interface StoreLoginView {
  state: StoreLoginState;
  userCode: string;
  verificationUri: string;
  verificationUriComplete: string;
  expiresAt: string;
  message: string | null;
}

export interface StoreWatchView {
  active: boolean;
  /** true：去官网挑选，等的是「我的库」里新出现的任何 Skill，不只是 itemIds。 */
  browse: boolean;
  itemIds: string[];
  installed: Array<{ id: string; name: string }>;
  errors: string[];
  until: string;
}

export interface StoreStatus {
  login: StoreLoginView | null;
  watch: StoreWatchView | null;
}

interface Login extends StoreLoginView { deviceCode: string; intervalMs: number }
interface Watch {
  itemIds: string[];
  installed: Array<{ id: string; name: string }>;
  errors: string[];
  until: number;
  timer: NodeJS.Timeout | null;
  checking: Promise<void> | null;
  browse: boolean;
  /** 去官网挑选之前「我的库」里已经有的，不算新加入（没装的在推荐页「我的库」里手动装）。 */
  baseline: Set<string>;
}

const logins = new Map<string, Login>();
const watches = new Map<string, Watch>();

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms).unref());

function httpUrl(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^https?:\/\//i.test(value)) throw new Error(`商店返回的${label}不对`);
  return value;
}

function loginView(login: Login): StoreLoginView {
  const { deviceCode: _code, intervalMs: _interval, ...view } = login;
  return view;
}

function watchView(watch: Watch): StoreWatchView {
  const done = new Set(watch.installed.map((item) => item.id));
  return {
    active: Date.now() < watch.until && (watch.browse || watch.itemIds.some((id) => !done.has(id))),
    browse: watch.browse,
    itemIds: watch.itemIds,
    installed: watch.installed,
    errors: watch.errors,
    until: new Date(watch.until).toISOString(),
  };
}

export function getStoreStatus(sourceId: string): StoreStatus {
  const login = logins.get(sourceId);
  const watch = watches.get(sourceId);
  return { login: login ? loginView(login) : null, watch: watch ? watchView(watch) : null };
}

/** 开始连接官网账号：返回授权码和授权页地址，后台轮询直到用户确认、拒绝或过期。 */
export async function startStoreLogin(sourceId: string): Promise<StoreLoginView> {
  const source = getStoreSource(sourceId);
  const code = await storeRequest<Record<string, unknown>>(source.url, "/device/code", { method: "POST" });
  if (typeof code.device_code !== "string" || typeof code.user_code !== "string") throw new Error("商店没有返回设备码");
  const verificationUri = httpUrl(code.verification_uri, "授权页地址");
  const login: Login = {
    state: "pending",
    userCode: code.user_code,
    verificationUri,
    verificationUriComplete: typeof code.verification_uri_complete === "string" && /^https?:\/\//i.test(code.verification_uri_complete) ? code.verification_uri_complete : verificationUri,
    expiresAt: new Date(Date.now() + Math.max(60, Number(code.expires_in) || 600) * 1000).toISOString(),
    message: null,
    deviceCode: code.device_code,
    intervalMs: POLL_OVERRIDE_MS || Math.max(LOGIN_POLL_MIN_MS, (Number(code.interval) || 5) * 1000),
  };
  logins.set(sourceId, login);
  void pollLogin(sourceId, source.url, login);
  return loginView(login);
}

async function pollLogin(sourceId: string, base: string, login: Login) {
  while (logins.get(sourceId) === login && Date.now() < Date.parse(login.expiresAt)) {
    await sleep(login.intervalMs);
    if (logins.get(sourceId) !== login) return; // 取消了，或者又点了一次连接
    try {
      const res = await storeRequest<{ access_token?: unknown; account?: Partial<StoreAccount> }>(base, "/device/token", { method: "POST", body: { device_code: login.deviceCode } });
      if (typeof res.access_token !== "string" || !res.access_token) throw new Error("商店没有返回登录令牌");
      const account: StoreAccount = {
        id: String(res.account?.id ?? ""),
        email: String(res.account?.email ?? ""),
        displayName: String(res.account?.displayName ?? res.account?.email ?? ""),
      };
      setStoreCredentials(sourceId, res.access_token, account);
      login.state = "connected";
      login.message = null;
      return;
    } catch (err) {
      const code = err instanceof StoreApiError ? err.code : "";
      if (code === "authorization_pending") continue;
      if (code === "slow_down") { login.intervalMs += 5_000; continue; }
      if (code === "expired_token") { login.state = "expired"; login.message = "授权码已过期，请重新连接"; return; }
      if (code === "access_denied") { login.state = "denied"; login.message = "你在官网拒绝了这次授权"; return; }
      if (code === "invalid_grant") { login.state = "expired"; login.message = "授权码已失效，请重新连接"; return; }
      // 网络抖动之类：记下原因，过期前继续试。
      login.message = (err as Error).message;
    }
  }
  if (logins.get(sourceId) === login && login.state === "pending") {
    login.state = "expired";
    login.message = "授权码已过期，请重新连接";
  }
}

/** 断开官网账号：取消进行中的授权，清掉本机保存的令牌。已经装好的 Skill 不受影响。 */
export function disconnectStore(sourceId: string) {
  getStoreSource(sourceId);
  logins.delete(sourceId);
  stopWatch(sourceId);
  watches.delete(sourceId);
  setStoreCredentials(sourceId, null, null);
}

function stopWatch(sourceId: string) {
  const watch = watches.get(sourceId);
  if (watch?.timer) clearTimeout(watch.timer);
  if (watch) watch.timer = null;
}

/** 选好的 Skill 去官网结算：返回结算页地址（页面用浏览器打开），同时开始等这些 Skill 出现在「已购」里。 */
export async function startStoreCheckout(sourceId: string, itemIds: string[]): Promise<{ url: string; watch: StoreWatchView }> {
  const source = getStoreSource(sourceId);
  if (!source.key) throw new Error("请先连接官网账号");
  const ids = [...new Set((Array.isArray(itemIds) ? itemIds : []).filter((id) => typeof id === "string" && id))];
  if (!ids.length) throw new Error("请至少选择一个 Skill");
  const catalog = await getCatalog();
  const items = catalog.items.filter((item) => item.sourceId === sourceId);
  for (const id of ids) {
    const item = items.find((entry) => entry.id === id);
    if (!item) throw new Error("选中的 Skill 不在商店目录里（可能已下架），请刷新");
    if (item.owned) throw new Error(`「${item.name}」已经买过了，直接安装就行`);
  }
  const res = await storeRequest<{ url?: unknown }>(source.url, `/checkout-url?items=${ids.map(encodeURIComponent).join(",")}`, { token: source.key })
    .catch((err) => { forgetStoreTokenOn(err, sourceId, source.key); throw err; });
  const url = httpUrl(res.url, "结算页地址");
  const existing = watches.get(sourceId);
  const keep = existing && Date.now() < existing.until ? existing : null;
  const watch: Watch = {
    itemIds: [...new Set([...(keep?.itemIds.filter((id) => !keep.installed.some((item) => item.id === id)) ?? []), ...ids])],
    installed: [],
    errors: [],
    until: Date.now() + WATCH_DURATION_MS,
    timer: null,
    checking: null,
    browse: keep?.browse ?? false,
    baseline: keep?.baseline ?? new Set(),
  };
  stopWatch(sourceId);
  watches.set(sourceId, watch);
  schedule(sourceId, watch);
  return { url, watch: watchView(watch) };
}

async function ownedIds(base: string, token: string, sourceId: string): Promise<Set<string>> {
  // 「我的库」：Skill、MCP、工具都算（老商店只有已购的 Skill）。
  const library = await fetchStoreLibrary(base, token).catch((err) => { forgetStoreTokenOn(err, sourceId, token); throw err; });
  return library.ids;
}

/** 去官网挑选：记下「我的库」现在有哪些，之后 15 分钟里在官网新加入库的 Skill 自动安装。页面自己打开官网。 */
export async function startStoreBrowse(sourceId: string): Promise<StoreWatchView> {
  const source = getStoreSource(sourceId);
  if (!source.key) throw new Error("请先连接官网账号");
  const baseline = await ownedIds(source.url, source.key, sourceId);
  const existing = watches.get(sourceId);
  const keep = existing && Date.now() < existing.until ? existing : null;
  const pending = keep ? keep.itemIds.filter((id) => !keep.installed.some((item) => item.id === id)) : [];
  // 结算中还没装上的照样等着，不算进「原来就有」。
  for (const id of pending) baseline.delete(id);
  const watch: Watch = { itemIds: pending, installed: [], errors: [], until: Date.now() + WATCH_DURATION_MS, timer: null, checking: null, browse: true, baseline };
  stopWatch(sourceId);
  watches.set(sourceId, watch);
  schedule(sourceId, watch);
  return watchView(watch);
}

/** 结束「去官网挑选」的等待；已经装好的不受影响。 */
export function stopStoreBrowse(sourceId: string): StoreStatus {
  getStoreSource(sourceId);
  const watch = watches.get(sourceId);
  if (watch?.browse) {
    watch.browse = false;
    if (!watchView(watch).active) stopWatch(sourceId);
  }
  return getStoreStatus(sourceId);
}

function schedule(sourceId: string, watch: Watch) {
  if (watches.get(sourceId) !== watch || !watchView(watch).active) return;
  watch.timer = setTimeout(() => {
    watch.timer = null;
    void checkStorePurchases(sourceId).finally(() => schedule(sourceId, watch));
  }, WATCH_INTERVAL_MS);
  watch.timer.unref();
}

/** 查一次「已购」，把正在等的、已经付款的 Skill 装上。页面上的「我已付款，刷新」也走这里。 */
export async function checkStorePurchases(sourceId: string): Promise<StoreStatus> {
  const watch = watches.get(sourceId);
  if (!watch) return getStoreStatus(sourceId);
  if (!watch.checking) {
    watch.checking = (async () => {
      try {
        const source = getStoreSource(sourceId);
        if (!source.key) return;
        const owned = await ownedIds(source.url, source.key, sourceId);
        watch.errors = watch.errors.filter((error) => !error.startsWith("查询购买记录失败"));
        if (watch.browse) {
          for (const id of owned) if (!watch.baseline.has(id) && !watch.itemIds.includes(id)) watch.itemIds.push(id);
        }
        const fresh = watch.itemIds.filter((id) => owned.has(id) && !watch.installed.some((item) => item.id === id));
        if (!fresh.length) return;
        invalidateCatalogCache(sourceId);
        const catalog = await getCatalog();
        for (const id of fresh) {
          const name = catalog.items.find((item) => item.sourceId === sourceId && item.id === id)?.name ?? id;
          try {
            await installCatalogItem({ sourceId, itemId: id });
            watch.installed.push({ id, name });
          } catch (err) {
            const message = (err as Error).message;
            // 要填参数的 MCP（令牌、目录之类）没法自动装，留在「我的库」里等用户填。
            watch.errors.push(message.startsWith("请填写")
              ? `「${name}」已在官网入库，安装前需要先填参数（${message.replace(/^请填写/, "")}），请在推荐页「我的库」里点「安装」`
              : `「${name}」已在官网入库，但安装失败：${message}。可以在推荐页「我的库」里点「安装」重试`);
            watch.itemIds = watch.itemIds.filter((entry) => entry !== id);
          }
        }
      } catch (err) {
        const message = `查询购买记录失败：${(err as Error).message}`;
        if (!watch.errors.includes(message)) watch.errors.push(message);
      } finally {
        watch.checking = null;
      }
    })();
  }
  await watch.checking;
  return getStoreStatus(sourceId);
}

/** 测试用：清掉内存里的授权和等待状态。 */
export function resetStoreState() {
  for (const id of watches.keys()) stopWatch(id);
  watches.clear();
  logins.clear();
}
