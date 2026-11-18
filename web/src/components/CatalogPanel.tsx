import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { api } from "../api/client";
import type { CatalogItemView, CatalogKind, CatalogSourceView, CatalogView, StoreStatus, ResourceGroup } from "../api/types";
import { confirmDialog, promptDialog } from "../utils/dialog";

const KIND_LABEL: Record<CatalogKind, string> = { skill: "Skill", mcp: "MCP", tool: "工具" };
const KIND_PAGE: Record<CatalogKind, string> = { skill: "Skill", mcp: "MCP", tool: "工具" };
/** 搜索时服务端最多给这么多条商店结果（和服务端 STORE_SEARCH_LIMIT 一致）。 */
const STORE_SEARCH_LIMIT = 120;

/** 数量太大时显示 9999+。 */
function countLabel(value: number) {
  return value > 9999 ? "9999+" : String(value);
}

function itemKey(item: CatalogItemView) {
  return `${item.sourceId}::${item.id}`;
}

function needsForm(item: CatalogItemView) {
  return Boolean(item.inputs?.length);
}

/** 商店里还没买的不能直接装；普通目录的条目 owned 是 undefined。 */
function canInstall(item: CatalogItemView) {
  return item.owned !== false;
}

function detail(item: CatalogItemView) {
  if (item.kind === "skill" && item.source) return `github.com/${item.source.repo}/${item.source.path}`;
  if (item.kind === "mcp" && item.mcp) return item.mcp.transport === "http" ? item.mcp.url ?? "" : [item.mcp.command, ...(item.mcp.args ?? [])].join(" ");
  return "";
}

function price(cents: number, currency = "CNY") {
  if (!cents) return "免费";
  const amount = (cents / 100).toFixed(2).replace(/\.00$/, "");
  return currency === "CNY" ? `¥${amount}` : `${amount} ${currency}`;
}

function openExternal(url: string) {
  // 桌面版会转给系统浏览器打开；网页版是新标签页。
  window.open(url, "_blank", "noopener,noreferrer");
}

/** 官网「我的库」里有、这台电脑还没装（或有新版本）的商店 Skill。 */
function inMyLibrary(item: CatalogItemView) {
  return item.owned === true && item.status !== "installed";
}

/** 推荐目录：浏览订阅源里整理好的 Skill / MCP / 工具，一键安装或更新。
 * 商店源每组只露几个，想看更多去官网挑：官网里加入「我的库」（免费领取或购买）后自动装到这台电脑。 */
export function CatalogPanel() {
  const [view, setView] = useState<CatalogView | null>(null);
  const [loading, setLoading] = useState(true);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [kind, setKind] = useState<CatalogKind | "">("");
  const [query, setQuery] = useState("");
  const [formFor, setFormFor] = useState<string | null>(null);
  const [formValues, setFormValues] = useState<Record<string, string>>({});
  const [showSources, setShowSources] = useState(false);
  const [newSource, setNewSource] = useState({ url: "", name: "", key: "", type: "catalog" as "catalog" | "store" });
  const [storeStatus, setStoreStatus] = useState<Record<string, StoreStatus>>({});
  const [checkoutUrl, setCheckoutUrl] = useState<Record<string, string>>({});
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [storeBusy, setStoreBusy] = useState<string | null>(null);
  const seenInstalled = useRef<Record<string, number>>({});
  const catalogRequest = useRef(0);
  const [installGroups, setInstallGroups] = useState<Record<CatalogKind, ResourceGroup[]>>({ skill: [], tool: [], mcp: [] });
  const [groupError, setGroupError] = useState("");
  const [groupAttempt, setGroupAttempt] = useState(0);
  const [formGroupId, setFormGroupId] = useState("");
  const [batchItems, setBatchItems] = useState<CatalogItemView[]>([]);
  const [batchGroups, setBatchGroups] = useState<Record<CatalogKind, string>>({ skill: "", tool: "", mcp: "" });

  useEffect(() => {
    let cancelled = false;
    setGroupError("");
    Promise.all([api.listResourceGroups("skill"), api.listResourceGroups("tool"), api.listResourceGroups("mcp")])
      .then(([skill, tool, mcp]) => { if (!cancelled) setInstallGroups({ skill, tool, mcp }); })
      .catch((err) => { if (!cancelled) setGroupError(`分类加载失败：${(err as Error).message}`); });
    return () => { cancelled = true; };
  }, [groupAttempt]);

  async function load(refresh = false) {
    const request = ++catalogRequest.current;
    const requestedQuery = queryRef.current;
    setLoading(true); setError("");
    try {
      const next = await api.getCatalog(refresh, requestedQuery);
      if (request === catalogRequest.current && requestedQuery === queryRef.current) setView(next);
    }
    catch (err) { if (request === catalogRequest.current && requestedQuery === queryRef.current) setError((err as Error).message); }
    finally { if (request === catalogRequest.current) setLoading(false); }
  }
  // 商店条目太多，搜索交给服务端；输入停一下再查。
  const queryRef = useRef(query);
  queryRef.current = query;
  const firstLoad = useRef(true);
  useEffect(() => {
    if (firstLoad.current) { firstLoad.current = false; void load(); return; }
    const timer = window.setTimeout(() => void load(), 300);
    return () => window.clearTimeout(timer);
  }, [query]);

  useEffect(() => () => { catalogRequest.current++; }, []);

  const stores = useMemo(() => (view?.sources ?? []).filter((source) => source.type === "store" && source.enabled), [view]);
  const storeIds = stores.map((source) => source.id).join(",");

  const statusRef = useRef(storeStatus);
  statusRef.current = storeStatus;
  function applyStatus(sourceId: string, status: StoreStatus) {
    const prev = statusRef.current[sourceId];
    setStoreStatus((current) => ({ ...current, [sourceId]: status }));
    if (status.login?.state === "connected" && prev?.login?.state === "pending") {
      setNotice("已连接官网账号。");
      void load();
    }
    const installed = status.watch?.installed ?? [];
    const seen = seenInstalled.current[sourceId] ?? 0;
    if (installed.length > seen) {
      setNotice(`已从官网自动安装：${installed.slice(seen).map((item) => `「${item.name}」`).join("、")}，可以在「Skill」页查看。`);
      void load();
    }
    seenInstalled.current[sourceId] = installed.length;
  }

  const applyRef = useRef(applyStatus);
  applyRef.current = applyStatus;

  // 打开页面时读一次商店状态（可能刚才有进行中的授权或等待付款）。
  useEffect(() => {
    if (!storeIds) return;
    for (const id of storeIds.split(",")) {
      api.getStoreStatus(id).then((status) => {
        seenInstalled.current[id] = status.watch?.installed.length ?? 0;
        setStoreStatus((current) => ({ ...current, [id]: status }));
      }).catch(() => {});
    }
  }, [storeIds]);

  // 授权中、等付款时每 2 秒刷新一次状态；安装本身在服务端进行，页面关了也会装。
  const polling = Object.entries(storeStatus).filter(([, status]) => status.login?.state === "pending" || status.watch?.active).map(([id]) => id).join(",");
  useEffect(() => {
    if (!polling) return;
    const timer = window.setInterval(() => {
      for (const id of polling.split(",")) api.getStoreStatus(id).then((status) => applyRef.current(id, status)).catch(() => {});
    }, 2000);
    return () => window.clearInterval(timer);
  }, [polling]);

  const visible = useMemo(() => {
    const text = query.trim().toLowerCase();
    return (view?.items ?? []).filter((item) => (!kind || item.kind === kind)
      && (!text || [item.name, item.summary, ...(item.tags ?? [])].join(" ").toLowerCase().includes(text)));
  }, [view, kind, query]);

  const myLibrary = useMemo(() => visible.filter(inMyLibrary), [visible]);

  const sections = useMemo(() => {
    const result: { key: string; sourceId: string; name: string; description: string; url: string | null; items: CatalogItemView[] }[] = [];
    for (const item of visible) {
      if (inMyLibrary(item)) continue;
      const group = view?.groups.find((entry) => entry.sourceId === item.sourceId && entry.id === item.group);
      const key = `${item.sourceId}::${item.group ?? ""}`;
      let section = result.find((entry) => entry.key === key);
      if (!section) {
        const source = view?.sources.find((entry) => entry.id === item.sourceId);
        const sourceName = source && (!source.builtin || source.type === "store") ? `${source.catalogName ?? source.name} · ` : "";
        section = { key, sourceId: item.sourceId, name: `${sourceName}${group?.name ?? "其它"}`, description: group?.description ?? "", url: group?.url ?? null, items: [] };
        result.push(section);
      }
      section.items.push(item);
    }
    // 商店的分组排在最前面，紧挨着上面的商店栏（连接账号、等待付款）。
    const isStoreSection = (sourceId: string) => view?.sources.find((entry) => entry.id === sourceId)?.type === "store";
    return [...result.filter((section) => isStoreSection(section.sourceId)), ...result.filter((section) => !isStoreSection(section.sourceId))];
  }, [visible, view]);

  async function install(item: CatalogItemView, inputs?: Record<string, string>, force = false, groupId?: string | null): Promise<boolean> {
    setBusyKey(itemKey(item)); setError(""); setNotice("");
    try {
      const result = await api.installCatalogItem({ sourceId: item.sourceId, itemId: item.id, inputs, force, groupId });
      setNotice(`${result.action === "updated" ? "已更新" : "已安装"}「${item.name}」，可以在「${KIND_PAGE[item.kind]}」页查看，在工作区、聊天或角色里勾选就能用。${result.warnings.length ? ` 提示：${result.warnings.join("；")}` : ""}`);
      setFormFor(null);
      await load();
      return true;
    } catch (err) {
      if ((err as { status?: number }).status === 409) {
        setBusyKey(null);
        if (await confirmDialog(`${(err as Error).message}。要继续更新吗？`, { title: `更新「${item.name}」`, danger: true, confirmText: "覆盖并更新" })) return install(item, inputs, true, groupId);
        return false;
      }
      setError(`「${item.name}」：${(err as Error).message}`);
      return false;
    } finally {
      setBusyKey(null);
    }
  }

  function openForm(item: CatalogItemView) {
    setFormFor(itemKey(item));
    setFormGroupId(item.status === "not_installed" ? "" : "__keep");
    setFormValues(Object.fromEntries((item.inputs ?? []).map((input) => [input.key, item.savedInputs[input.key] ?? input.default ?? ""])));
  }

  function act(item: CatalogItemView) {
    openForm(item);
  }

  async function installGroup(items: CatalogItemView[]) {
    const todo = items.filter((item) => item.status !== "installed" && !needsForm(item) && canInstall(item));
    setBatchGroups({ skill: "", tool: "", mcp: "" });
    setBatchItems(todo);
  }

  async function confirmBatch() {
    for (const item of batchItems) {
      const group = batchGroups[item.kind];
      if (!(await install(item, undefined, false, group || (item.status === "not_installed" ? null : undefined)))) return;
      setBatchItems((items) => items.filter((entry) => itemKey(entry) !== itemKey(item)));
    }
  }

  function submitForm(event: FormEvent, item: CatalogItemView) {
    event.preventDefault();
    void install(item, formValues, false, formGroupId === "__keep" ? undefined : formGroupId || null);
  }

  async function addSource(event: FormEvent) {
    event.preventDefault();
    setError("");
    try {
      await api.addCatalogSource({ url: newSource.url, name: newSource.name || undefined, key: newSource.type === "catalog" ? newSource.key || undefined : undefined, type: newSource.type });
      setNewSource({ url: "", name: "", key: "", type: "catalog" });
      await load(true);
    } catch (err) { setError((err as Error).message); }
  }

  async function changeKey(sourceId: string, name: string) {
    const key = await promptDialog("留空表示清除密钥。", { title: `「${name}」的访问密钥`, secret: true, singleLine: true, placeholder: "访问密钥" });
    if (key === null) return;
    try { await api.updateCatalogSource(sourceId, { key }); await load(true); }
    catch (err) { setError((err as Error).message); }
  }

  async function removeSource(sourceId: string, name: string) {
    if (!(await confirmDialog("已经装好的 Skill、MCP 和工具不受影响。", { title: `删除订阅源「${name}」？`, danger: true }))) return;
    try { await api.deleteCatalogSource(sourceId); await load(); }
    catch (err) { setError((err as Error).message); }
  }

  async function toggleSource(sourceId: string, enabled: boolean) {
    try { await api.updateCatalogSource(sourceId, { enabled }); await load(); }
    catch (err) { setError((err as Error).message); }
  }

  async function connectStore(source: CatalogSourceView) {
    setStoreBusy(source.id); setError("");
    try {
      const login = await api.startStoreLogin(source.id);
      setStoreStatus((current) => ({ ...current, [source.id]: { login, watch: current[source.id]?.watch ?? null } }));
      openExternal(login.verificationUriComplete);
    } catch (err) { setError(`连接「${source.name}」失败：${(err as Error).message}`); }
    finally { setStoreBusy(null); }
  }

  async function disconnectStore(source: CatalogSourceView) {
    if (!(await confirmDialog("只清除这台电脑上保存的登录，已经装好的 Skill 不受影响。以后要买或更新 Skill 时再连接。", { title: `断开「${source.name}」的官网账号？`, confirmText: "断开" }))) return;
    try {
      await api.disconnectStore(source.id);
      setStoreStatus((current) => ({ ...current, [source.id]: { login: null, watch: null } }));
      await load();
    } catch (err) { setError((err as Error).message); }
  }

  function toggleSelect(item: CatalogItemView) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(itemKey(item))) next.delete(itemKey(item)); else next.add(itemKey(item));
      return next;
    });
  }

  async function checkout(source: CatalogSourceView, items: CatalogItemView[]) {
    setStoreBusy(source.id); setError(""); setNotice("");
    try {
      const result = await api.startStoreCheckout(source.id, items.map((item) => item.id));
      seenInstalled.current[source.id] = 0;
      setStoreStatus((current) => ({ ...current, [source.id]: { login: current[source.id]?.login ?? null, watch: result.watch } }));
      setCheckoutUrl((current) => ({ ...current, [source.id]: result.url }));
      setSelected((current) => new Set([...current].filter((key) => !items.some((item) => itemKey(item) === key))));
      openExternal(result.url);
    } catch (err) { setError(`去官网购买失败：${(err as Error).message}`); }
    finally { setStoreBusy(null); }
  }

  async function checkNow(sourceId: string) {
    setStoreBusy(sourceId);
    try {
      const status = await api.checkStorePurchases(sourceId);
      applyStatus(sourceId, status);
      if (status.watch?.active && !(status.watch.installed.length > (seenInstalled.current[sourceId] ?? 0))) setNotice("还没收到付款结果，付款完成后几秒内会自动安装。");
    } catch (err) { setError((err as Error).message); }
    finally { setStoreBusy(null); }
  }

  /** 去官网挑选：打开官网（整站或某一组），连了账号的话同时开始等「我的库」里新加入的 Skill，到了就自动装。 */
  async function browseStore(source: CatalogSourceView, url?: string | null) {
    const target = url || source.homeUrl;
    if (!target) return;
    // 先开网页（等接口返回再开，浏览器可能当成弹窗拦掉）。
    openExternal(target);
    if (!source.account) {
      setNotice("先点「连接官网账号」，之后在官网加入「我的库」的 Skill 才会自动装到这台电脑。");
      return;
    }
    setError("");
    try {
      const watch = await api.startStoreBrowse(source.id);
      seenInstalled.current[source.id] = 0;
      setStoreStatus((current) => ({ ...current, [source.id]: { login: current[source.id]?.login ?? null, watch } }));
    } catch (err) { setError(`开始等待官网入库失败：${(err as Error).message}`); }
  }

  async function stopBrowse(sourceId: string) {
    try { applyStatus(sourceId, await api.stopStoreBrowse(sourceId)); }
    catch (err) { setError((err as Error).message); }
  }

  const counts = view?.totals?.kinds ?? (view?.items ?? []).reduce((acc, item) => { acc[item.kind]++; return acc; }, { skill: 0, mcp: 0, tool: 0 } as Record<CatalogKind, number>);
  const storeMatched = view?.totals?.storeMatched ?? null;
  const updates = (view?.items ?? []).filter((item) => item.status === "update").length;
  const selectedItems = (view?.items ?? []).filter((item) => selected.has(itemKey(item)) && item.owned === false);

  function storeOf(item: CatalogItemView) {
    return stores.find((source) => source.id === item.sourceId);
  }

  function renderCard(item: CatalogItemView) {
    const key = itemKey(item);
    const busy = busyKey === key;
    const forSale = item.owned === false;
    const picked = selected.has(key);
    return <article className={`catalog-card status-${item.status}${forSale ? " for-sale" : ""}${picked ? " picked" : ""}`} key={key}>
      <div className="catalog-card-head">
        <strong>{item.name}</strong>
        <span className="license-badge neutral">{KIND_LABEL[item.kind]}</span>
        {item.license && <span className="license-badge ok">{item.license}</span>}
        {item.owned === true && item.status === "not_installed" && <span className="license-badge ok">已拥有</span>}
        {item.status === "installed" && <span className="license-badge ok">已安装</span>}
        {item.status === "update" && <span className="license-badge warn">有更新</span>}
        {item.priceCents !== undefined && forSale && <span className="catalog-price">{price(item.priceCents, item.currency)}</span>}
      </div>
      <p>{item.summary}</p>
      {detail(item) && <code className="catalog-detail">{detail(item)}</code>}
      {!!item.tags?.length && <div className="catalog-tags">{item.tags.map((tag) => <span key={tag}>{tag}</span>)}</div>}
      {formFor === key ? <form className="catalog-input-form" onSubmit={(event) => submitForm(event, item)}>
        <label><span>安装到分类</span><select className="field" aria-label={`「${item.name}」安装分类`} value={formGroupId} onChange={(event) => setFormGroupId(event.target.value)}>
          {item.status !== "not_installed" && <option value="__keep">保留当前分类</option>}
          <option value="">未分组</option>
          {installGroups[item.kind].map((group) => <option key={group.id} value={group.id}>{group.name}</option>)}
        </select><small>不选择则放入未分组；可在{KIND_PAGE[item.kind]}页新建分类、批量移动。</small></label>
        {(item.inputs ?? []).map((input) => <label key={input.key}>
          <span>{input.label}{input.required ? " *" : ""}</span>
          <input className="field" type={input.secret ? "password" : "text"} autoComplete="off"
            placeholder={input.secret && item.status !== "not_installed" ? "留空沿用上次填的" : input.placeholder ?? ""}
            required={Boolean(input.required) && !(input.secret && item.status !== "not_installed")}
            value={formValues[input.key] ?? ""} onChange={(event) => setFormValues({ ...formValues, [input.key]: event.target.value })} />
          {input.help && <small>{input.help}</small>}
        </label>)}
        <div className="resource-card-actions">
          <button className="btn btn-primary btn-sm" disabled={busy}>{busy ? "处理中..." : item.status === "not_installed" ? "安装" : "保存并更新"}</button>
          <button className="btn btn-ghost btn-sm" type="button" onClick={() => setFormFor(null)}>取消</button>
        </div>
      </form> : <div className="resource-card-actions">
        {item.detailUrl && <button className="btn btn-ghost btn-sm" onClick={() => storeOf(item) ? void browseStore(storeOf(item)!, item.detailUrl) : openExternal(item.detailUrl!)}>详情</button>}
        {forSale && !item.priceCents && item.detailUrl && storeOf(item)
          ? <button className="btn btn-primary btn-sm" onClick={() => void browseStore(storeOf(item)!, item.detailUrl)}>去官网领取</button>
          : forSale
          ? <label className="catalog-pick"><input type="checkbox" checked={picked} onChange={() => toggleSelect(item)} />{picked ? "已选" : "选择"}</label>
          : item.status === "installed"
          ? <>{needsForm(item) && <button className="btn btn-ghost btn-sm" disabled={busyKey !== null} onClick={() => openForm(item)}>修改参数</button>}<button className="btn btn-sm" disabled>已安装</button></>
          : <button className="btn btn-primary btn-sm" disabled={busyKey !== null} onClick={() => act(item)}>{busy ? "处理中..." : item.status === "update" ? `更新到 v${item.version}` : "安装"}</button>}
      </div>}
    </article>;
  }

  return <div className="resource-center catalog-page">
    <header className="resource-hero">
      <div>
        <div className="dashboard-kicker">推荐目录</div>
        <h1>一键装好常用的 Skill、MCP 和工具</h1>
        <p>从订阅源里挑选，安装后自动出现在对应页面，在工作区、聊天或角色里勾选就能用。目录更新后这里会提示有新版本。</p>
      </div>
    </header>
    {groupError && <div className="page-load-warning" role="status"><span>{groupError}，仍可安装到未分组。</span><button className="btn btn-sm" onClick={() => setGroupAttempt((attempt) => attempt + 1)}>重试</button></div>}
    {batchItems.length > 0 && <section className="catalog-batch-plan resource-panel" aria-label="批量安装分类">
      <div className="workspace-section-head"><div><h3>确认安装 {batchItems.length} 项</h3><span>按资源类型选择分类。新安装默认未分组，更新默认保留原分类；需要参数的项目请单独安装。</span></div></div>
      <div className="catalog-destination-grid">{(["skill", "tool", "mcp"] as const).filter((type) => batchItems.some((item) => item.kind === type)).map((type) => <label key={type}><span>{KIND_LABEL[type]} 分类</span><select className="field" value={batchGroups[type]} onChange={(event) => setBatchGroups((groups) => ({ ...groups, [type]: event.target.value }))}><option value="">默认（新增到未分组，更新保留分类）</option>{installGroups[type].map((group) => <option key={group.id} value={group.id}>{group.name}</option>)}</select></label>)}</div>
      <div className="resource-card-actions"><button className="btn" disabled={busyKey !== null} onClick={() => setBatchItems([])}>取消</button><button className="btn btn-primary" disabled={busyKey !== null} onClick={() => void confirmBatch()}>{busyKey ? "安装中..." : "确认安装"}</button></div>
    </section>}

    <div className="catalog-toolbar">
      <nav className="catalog-kinds" aria-label="按类型筛选">
        {(["", "skill", "mcp", "tool"] as const).map((value) => <button key={value || "all"} className={kind === value ? "active" : ""} onClick={() => setKind(value)}>
          {value ? KIND_LABEL[value] : "全部"} <span>{countLabel(value ? counts[value] : counts.skill + counts.mcp + counts.tool)}</span>
        </button>)}
      </nav>
      <input className="field" aria-label="搜索推荐" placeholder="搜索名称、说明、标签" value={query} onChange={(event) => setQuery(event.target.value)} />
      <button className="btn" disabled={loading} onClick={() => void load(true)}>{loading ? "读取中..." : "刷新"}</button>
      <button className={`btn ${showSources ? "btn-primary" : ""}`} onClick={() => setShowSources((value) => !value)}>订阅源{view ? ` (${view.sources.length})` : ""}</button>
    </div>

    {error && <div className="form-error" role="alert">{error}</div>}
    {notice && <div className="resource-tab-note ok" role="status">{notice}</div>}
    {updates > 0 && <div className="resource-tab-note warn">{updates} 项有新版本，点「更新」换成新版本。</div>}
    {view?.sources.filter((source) => source.error).map((source) => <div className="resource-tab-note warn" key={source.id}>订阅源「{source.name}」读取失败：{source.error}</div>)}
    {view?.warnings.map((warning) => <div className="resource-tab-note" key={warning}>{warning}</div>)}

    {stores.map((source) => {
      const status = storeStatus[source.id];
      const login = status?.login;
      const watch = status?.watch;
      const busy = storeBusy === source.id;
      const waitingNames = (watch?.itemIds ?? []).filter((id) => !watch?.installed.some((item) => item.id === id))
        .map((id) => view?.items.find((item) => item.sourceId === source.id && item.id === id)?.name ?? id);
      return <section className="resource-panel store-bar" key={source.id}>
        <div className="store-bar-head">
          <div>
            <strong>{source.catalogName ?? source.name}</strong>
            <span>{source.error ? "连不上官网，下面暂时没有商店的 Skill。官网打开后点「刷新」。" : source.account ? `已连接：${source.account.displayName && source.account.displayName !== source.account.email ? `${source.account.displayName}（${source.account.email}）` : source.account.email}。每组只列几个，更多的去官网挑，在官网加入「我的库」后自动装到这台电脑。` : "连接官网账号后，在官网加入「我的库」的 Skill、MCP 和工具会自动装到这台电脑。"}</span>
          </div>
          <div className="resource-card-actions">
            {source.homeUrl && !source.error && <button className="btn btn-sm" onClick={() => void browseStore(source)}>去官网挑选更多</button>}
            {source.account
              ? <button className="btn btn-ghost btn-sm" onClick={() => void disconnectStore(source)}>断开</button>
              : login?.state !== "pending" && <button className="btn btn-primary btn-sm" disabled={busy} onClick={() => void connectStore(source)}>{busy ? "连接中..." : "连接官网账号"}</button>}
          </div>
        </div>
        {login?.state === "pending" && !source.account && <div className="store-login">
          <div>
            <span>授权码</span>
            <code className="store-user-code">{login.userCode}</code>
          </div>
          <p>已在浏览器打开官网授权页，核对授权码一致后点「确认」，这里会自动连上。浏览器没打开的话<a href={login.verificationUriComplete} target="_blank" rel="noreferrer">点这里打开</a>。</p>
          <button className="btn btn-ghost btn-sm" onClick={() => void connectStore(source)}>换一个授权码</button>
        </div>}
        {login && (login.state === "expired" || login.state === "denied" || login.state === "error") && !source.account && <div className="resource-tab-note warn">{login.message ?? "连接没有完成"}，可以重新点「连接官网账号」。</div>}
        {watch?.active && watch.browse && <div className="store-waiting">
          <span className="store-spinner" aria-hidden="true" />
          <div>
            <strong>正在等你在官网加入「我的库」的 Skill</strong>
            <p>在官网点「加入我的库」或买完后，几秒内自动装到这台电脑（15 分钟内有效）。{watch.installed.length > 0 && `已装好：${watch.installed.map((item) => item.name).join("、")}。`}{waitingNames.length > 0 && `正在安装：${waitingNames.join("、")}。`}</p>
          </div>
          <button className="btn btn-sm" disabled={busy} onClick={() => void checkNow(source.id)}>{busy ? "查询中..." : "立即检查"}</button>
          <button className="btn btn-ghost btn-sm" onClick={() => void stopBrowse(source.id)}>结束</button>
        </div>}
        {watch?.active && !watch.browse && <div className="store-waiting">
          <span className="store-spinner" aria-hidden="true" />
          <div>
            <strong>等待付款：{waitingNames.join("、")}</strong>
            <p>在浏览器里付款完成后，这里会自动安装（15 分钟内有效）。{checkoutUrl[source.id] && <>浏览器没打开的话<a href={checkoutUrl[source.id]} target="_blank" rel="noreferrer">点这里打开结算页</a>。</>}</p>
          </div>
          <button className="btn btn-sm" disabled={busy} onClick={() => void checkNow(source.id)}>{busy ? "查询中..." : "我已付款，刷新"}</button>
        </div>}
        {watch?.errors.map((message) => <div className="resource-tab-note warn" key={message}>{message}</div>)}
      </section>;
    })}

    {showSources && view && <section className="resource-panel catalog-sources">
      <h3>订阅源</h3>
      <div className="catalog-source-list">
        {view.sources.map((source) => <div className="catalog-source" key={source.id}>
          <div>
            <strong>{source.name}{source.type === "store" && <span className="license-badge neutral">商店</span>}{source.builtin && <span className="license-badge neutral">内置</span>}{source.type === "store" ? source.account && <span className="license-badge ok">已连接账号</span> : source.hasKey && <span className="license-badge ok">已设密钥</span>}</strong>
            <code>{source.url}</code>
            <span>{!source.enabled ? "已关闭" : source.error ? `读取失败：${source.error}` : source.bundled ? "连不上，正在用随程序附带的目录" : source.updatedAt ? `目录更新于 ${source.updatedAt}` : "正常"}</span>
          </div>
          <div className="resource-card-actions">
            <button className="btn btn-ghost btn-sm" onClick={() => void toggleSource(source.id, !source.enabled)}>{source.enabled ? "关闭" : "打开"}</button>
            {!source.builtin && source.type !== "store" && <button className="btn btn-ghost btn-sm" onClick={() => void changeKey(source.id, source.name)}>密钥</button>}
            {!source.builtin && <button className="btn btn-ghost btn-sm" onClick={() => void removeSource(source.id, source.name)}>删除</button>}
          </div>
        </div>)}
      </div>
      <form className="catalog-source-form" onSubmit={(event) => void addSource(event)}>
        <select className="field" aria-label="订阅源类型" value={newSource.type} onChange={(event) => setNewSource({ ...newSource, type: event.target.value as "catalog" | "store" })}>
          <option value="catalog">目录文件</option>
          <option value="store">商店</option>
        </select>
        <input className="field" aria-label="订阅地址" required value={newSource.url} onChange={(event) => setNewSource({ ...newSource, url: event.target.value })}
          placeholder={newSource.type === "store" ? "商店接口地址（https://…/api/xgent/v1）" : "订阅地址（https://…/catalog.json 或本机文件路径）"} />
        <input className="field" aria-label="订阅源名称" placeholder="名称（可选）" value={newSource.name} onChange={(event) => setNewSource({ ...newSource, name: event.target.value })} />
        {newSource.type === "catalog"
          ? <input className="field" aria-label="访问密钥" type="password" autoComplete="off" placeholder="访问密钥（可选）" value={newSource.key} onChange={(event) => setNewSource({ ...newSource, key: event.target.value })} />
          : <span className="catalog-source-form-hint">添加后点「连接官网账号」登录</span>}
        <button className="btn btn-sm">添加</button>
      </form>
      <span className="config-field-help">目录文件是一个 JSON 文件；商店是卖 Skill 的网站，在官网付款，Xgent 里不处理任何支付。密钥和登录凭证只保存在这台电脑上，读取时放在请求头里发给订阅地址。</span>
    </section>}

    {loading && !view && <div className="workspace-loading">正在读取推荐目录...</div>}
    {view && !visible.length && !loading && <div className="workspace-empty">没有符合条件的条目。{stores.some((source) => source.homeUrl) && " 可以去官网搜搜看。"}</div>}
    {storeMatched !== null && storeMatched > STORE_SEARCH_LIMIT && <div className="resource-tab-note">商店里搜到 {countLabel(storeMatched)} 个，这里只列前 {STORE_SEARCH_LIMIT} 个，换个更具体的词，或者{stores[0]?.homeUrl ? <button className="btn btn-ghost btn-sm" onClick={() => void browseStore(stores[0]!)}>去官网查看</button> : "去官网查看"}。</div>}

    {myLibrary.length > 0 && <section className="catalog-section catalog-my-library">
      <div className="workspace-section-head">
        <div><h3>我的库 · 官网已入库，这台电脑还没装</h3><span>在官网加入「我的库」或买过的 Skill、MCP 和工具，点「安装」装到这台电脑（要填参数的 MCP 会先让你填）；有新版本的点「更新」。</span></div>
        {myLibrary.length > 1 && <button className="btn btn-sm btn-primary" disabled={busyKey !== null} onClick={() => void installGroup(myLibrary)}>全部安装 / 更新 {myLibrary.length} 项</button>}
      </div>
      <div className="catalog-grid">{myLibrary.map(renderCard)}</div>
    </section>}

    {sections.map((section) => {
      const isStoreSection = view?.sources.find((entry) => entry.id === section.sourceId)?.type === "store";
      const storeSource = isStoreSection ? stores.find((entry) => entry.id === section.sourceId) : undefined;
      // 商店每组只拿到前几个，总数看服务端给的。
      const total = view?.totals?.groups[section.key] ?? section.items.length;
      const cut = isStoreSection && !query.trim() && total > section.items.length;
      const shown = section.items;
      const pending = section.items.filter((item) => item.status !== "installed" && !needsForm(item) && canInstall(item));
      return <section className="catalog-section" key={section.key}>
        <div className="workspace-section-head">
          <div><h3>{section.name}</h3>{section.description && <span>{section.description}</span>}</div>
          <div className="resource-card-actions">
            {pending.length > 1 && <button className="btn btn-sm" disabled={busyKey !== null} onClick={() => void installGroup(section.items)}>安装 / 更新这组 {pending.length} 项</button>}
            {storeSource && (section.url || storeSource.homeUrl) && <button className="btn btn-sm" onClick={() => void browseStore(storeSource, section.url)}>{cut ? `去官网看全部 ${countLabel(total)} 个` : "去官网看更多"}</button>}
          </div>
        </div>
        <div className="catalog-grid">{shown.map(renderCard)}</div>
      </section>;
    })}


    {stores.map((source) => {
      const items = selectedItems.filter((item) => item.sourceId === source.id);
      if (!items.length) return null;
      const total = items.reduce((sum, item) => sum + (item.priceCents ?? 0), 0);
      const busy = storeBusy === source.id;
      return <div className="store-checkout-bar" key={source.id} role="region" aria-label="已选的 Skill">
        <div>
          <strong>已选 {items.length} 个 · {price(total, items[0]?.currency)}</strong>
          <span>{items.map((item) => item.name).join("、")}</span>
        </div>
        <button className="btn btn-ghost btn-sm" onClick={() => setSelected((current) => new Set([...current].filter((key) => !items.some((item) => itemKey(item) === key))))}>清空</button>
        {source.account
          ? <button className="btn btn-primary" disabled={busy} onClick={() => void checkout(source, items)}>{busy ? "正在打开..." : "去官网购买"}</button>
          : <button className="btn btn-primary" disabled={busy || storeStatus[source.id]?.login?.state === "pending"} onClick={() => void connectStore(source)}>先连接官网账号</button>}
      </div>;
    })}
  </div>;
}
