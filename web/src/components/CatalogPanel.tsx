import { useEffect, useMemo, useState, type FormEvent } from "react";
import { api } from "../api/client";
import type { CatalogItemView, CatalogKind, CatalogView } from "../api/types";
import { confirmDialog, promptDialog } from "../utils/dialog";

const KIND_LABEL: Record<CatalogKind, string> = { skill: "Skill", mcp: "MCP", tool: "工具" };
const KIND_PAGE: Record<CatalogKind, string> = { skill: "Skill", mcp: "MCP", tool: "工具" };

function itemKey(item: CatalogItemView) {
  return `${item.sourceId}::${item.id}`;
}

function needsForm(item: CatalogItemView) {
  return Boolean(item.inputs?.length);
}

function detail(item: CatalogItemView) {
  if (item.kind === "skill" && item.source) return `github.com/${item.source.repo}/${item.source.path}`;
  if (item.kind === "mcp" && item.mcp) return item.mcp.transport === "http" ? item.mcp.url ?? "" : [item.mcp.command, ...(item.mcp.args ?? [])].join(" ");
  return "";
}

/** 推荐目录：浏览订阅源里整理好的 Skill / MCP / 工具，一键安装或更新。 */
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
  const [newSource, setNewSource] = useState({ url: "", name: "", key: "" });

  async function load(refresh = false) {
    setLoading(true); setError("");
    try { setView(await api.getCatalog(refresh)); }
    catch (err) { setError((err as Error).message); }
    finally { setLoading(false); }
  }
  useEffect(() => { void load(); }, []);

  const visible = useMemo(() => {
    const text = query.trim().toLowerCase();
    return (view?.items ?? []).filter((item) => (!kind || item.kind === kind)
      && (!text || [item.name, item.summary, ...(item.tags ?? [])].join(" ").toLowerCase().includes(text)));
  }, [view, kind, query]);

  const sections = useMemo(() => {
    const result: { key: string; name: string; description: string; items: CatalogItemView[] }[] = [];
    for (const item of visible) {
      const group = view?.groups.find((entry) => entry.sourceId === item.sourceId && entry.id === item.group);
      const key = `${item.sourceId}::${group?.id ?? ""}`;
      let section = result.find((entry) => entry.key === key);
      if (!section) {
        const source = view?.sources.find((entry) => entry.id === item.sourceId);
        const sourceName = source && !source.builtin ? `${source.catalogName ?? source.name} · ` : "";
        section = { key, name: `${sourceName}${group?.name ?? "其它"}`, description: group?.description ?? "", items: [] };
        result.push(section);
      }
      section.items.push(item);
    }
    return result;
  }, [visible, view]);

  async function install(item: CatalogItemView, inputs?: Record<string, string>, force = false): Promise<boolean> {
    setBusyKey(itemKey(item)); setError(""); setNotice("");
    try {
      const result = await api.installCatalogItem({ sourceId: item.sourceId, itemId: item.id, inputs, force });
      setNotice(`${result.action === "updated" ? "已更新" : "已安装"}「${item.name}」，可以在「${KIND_PAGE[item.kind]}」页查看，在工作区、聊天或角色里勾选就能用。${result.warnings.length ? ` 提示：${result.warnings.join("；")}` : ""}`);
      setFormFor(null);
      await load();
      return true;
    } catch (err) {
      if ((err as { status?: number }).status === 409) {
        setBusyKey(null);
        if (await confirmDialog(`${(err as Error).message}。要继续更新吗？`, { title: `更新「${item.name}」`, danger: true, confirmText: "覆盖并更新" })) return install(item, inputs, true);
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
    setFormValues(Object.fromEntries((item.inputs ?? []).map((input) => [input.key, item.savedInputs[input.key] ?? input.default ?? ""])));
  }

  function act(item: CatalogItemView) {
    if (needsForm(item)) openForm(item); else void install(item);
  }

  async function installGroup(items: CatalogItemView[]) {
    const todo = items.filter((item) => item.status !== "installed" && !needsForm(item));
    for (const item of todo) {
      if (!(await install(item))) break;
    }
  }

  function submitForm(event: FormEvent, item: CatalogItemView) {
    event.preventDefault();
    void install(item, formValues);
  }

  async function addSource(event: FormEvent) {
    event.preventDefault();
    setError("");
    try {
      await api.addCatalogSource({ url: newSource.url, name: newSource.name || undefined, key: newSource.key || undefined });
      setNewSource({ url: "", name: "", key: "" });
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

  const counts = (view?.items ?? []).reduce((acc, item) => { acc[item.kind]++; return acc; }, { skill: 0, mcp: 0, tool: 0 } as Record<CatalogKind, number>);
  const updates = (view?.items ?? []).filter((item) => item.status === "update").length;

  return <div className="resource-center catalog-page">
    <header className="resource-hero">
      <div>
        <div className="dashboard-kicker">推荐目录</div>
        <h1>一键装好常用的 Skill、MCP 和工具</h1>
        <p>从订阅源里挑选，安装后自动出现在对应页面，在工作区、聊天或角色里勾选就能用。目录更新后这里会提示有新版本。</p>
      </div>
    </header>

    <div className="catalog-toolbar">
      <nav className="catalog-kinds" aria-label="按类型筛选">
        {(["", "skill", "mcp", "tool"] as const).map((value) => <button key={value || "all"} className={kind === value ? "active" : ""} onClick={() => setKind(value)}>
          {value ? KIND_LABEL[value] : "全部"} <span>{value ? counts[value] : view?.items.length ?? 0}</span>
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

    {showSources && view && <section className="resource-panel catalog-sources">
      <h3>订阅源</h3>
      <div className="catalog-source-list">
        {view.sources.map((source) => <div className="catalog-source" key={source.id}>
          <div>
            <strong>{source.name}{source.builtin && <span className="license-badge neutral">内置</span>}{source.hasKey && <span className="license-badge ok">已设密钥</span>}</strong>
            <code>{source.url}</code>
            <span>{!source.enabled ? "已关闭" : source.error ? `读取失败：${source.error}` : source.bundled ? "连不上，正在用随程序附带的目录" : source.updatedAt ? `目录更新于 ${source.updatedAt}` : "正常"}</span>
          </div>
          <div className="resource-card-actions">
            <button className="btn btn-ghost btn-sm" onClick={() => void toggleSource(source.id, !source.enabled)}>{source.enabled ? "关闭" : "打开"}</button>
            {!source.builtin && <button className="btn btn-ghost btn-sm" onClick={() => void changeKey(source.id, source.name)}>密钥</button>}
            {!source.builtin && <button className="btn btn-ghost btn-sm" onClick={() => void removeSource(source.id, source.name)}>删除</button>}
          </div>
        </div>)}
      </div>
      <form className="catalog-source-form" onSubmit={(event) => void addSource(event)}>
        <input className="field" aria-label="订阅地址" placeholder="订阅地址（https://…/catalog.json 或本机文件路径）" required value={newSource.url} onChange={(event) => setNewSource({ ...newSource, url: event.target.value })} />
        <input className="field" aria-label="订阅源名称" placeholder="名称（可选）" value={newSource.name} onChange={(event) => setNewSource({ ...newSource, name: event.target.value })} />
        <input className="field" aria-label="访问密钥" type="password" autoComplete="off" placeholder="访问密钥（可选）" value={newSource.key} onChange={(event) => setNewSource({ ...newSource, key: event.target.value })} />
        <button className="btn btn-sm">添加</button>
      </form>
      <span className="config-field-help">订阅源是一个 JSON 目录文件。密钥只保存在这台电脑上，读取时放在请求头里发给订阅地址。</span>
    </section>}

    {loading && !view && <div className="workspace-loading">正在读取推荐目录...</div>}
    {view && !visible.length && !loading && <div className="workspace-empty">没有符合条件的条目。</div>}

    {sections.map((section) => {
      const pending = section.items.filter((item) => item.status !== "installed" && !needsForm(item));
      return <section className="catalog-section" key={section.key}>
        <div className="workspace-section-head">
          <div><h3>{section.name}</h3>{section.description && <span>{section.description}</span>}</div>
          {pending.length > 1 && <button className="btn btn-sm" disabled={busyKey !== null} onClick={() => void installGroup(section.items)}>安装 / 更新这组 {pending.length} 项</button>}
        </div>
        <div className="catalog-grid">
          {section.items.map((item) => {
            const key = itemKey(item);
            const busy = busyKey === key;
            return <article className={`catalog-card status-${item.status}`} key={key}>
              <div className="catalog-card-head">
                <strong>{item.name}</strong>
                <span className="license-badge neutral">{KIND_LABEL[item.kind]}</span>
                {item.license && <span className="license-badge ok">{item.license}</span>}
                {item.status === "installed" && <span className="license-badge ok">已安装</span>}
                {item.status === "update" && <span className="license-badge warn">有更新</span>}
              </div>
              <p>{item.summary}</p>
              {detail(item) && <code className="catalog-detail">{detail(item)}</code>}
              {!!item.tags?.length && <div className="catalog-tags">{item.tags.map((tag) => <span key={tag}>{tag}</span>)}</div>}
              {formFor === key ? <form className="catalog-input-form" onSubmit={(event) => submitForm(event, item)}>
                {item.inputs!.map((input) => <label key={input.key}>
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
                {item.status === "installed"
                  ? <>{needsForm(item) && <button className="btn btn-ghost btn-sm" disabled={busyKey !== null} onClick={() => openForm(item)}>修改参数</button>}<button className="btn btn-sm" disabled>已安装</button></>
                  : <button className="btn btn-primary btn-sm" disabled={busyKey !== null} onClick={() => act(item)}>{busy ? "处理中..." : item.status === "update" ? `更新到 v${item.version}` : "安装"}</button>}
              </div>}
            </article>;
          })}
        </div>
      </section>;
    })}
  </div>;
}
