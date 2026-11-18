import { useEffect, useState } from "react";
import { api } from "../api/client";
import type { CatalogSourceView, StoreLoginView } from "../api/types";
import { confirmDialog } from "../utils/dialog";

function accountLabel(account: NonNullable<CatalogSourceView["account"]>) {
  return account.displayName && account.displayName !== account.email ? `${account.displayName}（${account.email}）` : account.email;
}

/** Skill 页上的「官网账号」：连接 / 断开商店账号。买 Skill 还是去推荐页。没有配商店时不显示。 */
export function StoreAccountBar({ onOpenStore }: { onOpenStore?: () => void }) {
  const [stores, setStores] = useState<CatalogSourceView[]>([]);
  const [logins, setLogins] = useState<Record<string, StoreLoginView | null>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");

  async function load() {
    try { setStores((await api.listCatalogSources()).filter((source) => source.type === "store" && source.enabled)); }
    catch { /* 读不到就不显示这一栏 */ }
  }
  useEffect(() => { void load(); }, []);

  // 打开页面时接上进行中的授权（可能是在推荐页点的）。
  const storeIds = stores.map((source) => source.id).join(",");
  useEffect(() => {
    if (!storeIds) return;
    for (const id of storeIds.split(",")) api.getStoreStatus(id).then((status) => setLogins((current) => ({ ...current, [id]: status.login }))).catch(() => {});
  }, [storeIds]);

  // 授权中每 2 秒查一次，连上了就重新读账号。
  const pending = Object.entries(logins).filter(([, login]) => login?.state === "pending").map(([id]) => id).join(",");
  useEffect(() => {
    if (!pending) return;
    const timer = window.setInterval(() => {
      for (const id of pending.split(",")) {
        api.getStoreStatus(id).then((status) => {
          setLogins((current) => ({ ...current, [id]: status.login }));
          if (status.login?.state !== "pending") void load();
        }).catch(() => {});
      }
    }, 2000);
    return () => window.clearInterval(timer);
  }, [pending]);

  async function connect(source: CatalogSourceView) {
    setBusy(source.id); setError("");
    try {
      const login = await api.startStoreLogin(source.id);
      setLogins((current) => ({ ...current, [source.id]: login }));
      // 桌面版会转给系统浏览器打开；网页版是新标签页。
      window.open(login.verificationUriComplete, "_blank", "noopener,noreferrer");
    } catch (err) { setError(`连接「${source.name}」失败：${(err as Error).message}`); }
    finally { setBusy(null); }
  }

  async function disconnect(source: CatalogSourceView) {
    if (!(await confirmDialog("只清除这台电脑上保存的登录，已经装好的 Skill 不受影响。以后要买或更新 Skill 时再连接。", { title: `断开「${source.name}」的官网账号？`, confirmText: "断开" }))) return;
    try {
      await api.disconnectStore(source.id);
      setLogins((current) => ({ ...current, [source.id]: null }));
      await load();
    } catch (err) { setError((err as Error).message); }
  }

  if (!stores.length) return null;
  return <>
    {error && <div className="form-error" role="alert">{error}</div>}
    {stores.map((source) => {
      const login = logins[source.id];
      return <section className="resource-panel store-bar" key={source.id}>
        <div className="store-bar-head">
          <div>
            <strong>{source.name} · 官网账号</strong>
            <span>{source.account ? `已连接：${accountLabel(source.account)}` : "连接官网账号后，可以在「推荐」页购买 Skill，付款后自动装到这里；买过的换电脑也能恢复。"}</span>
          </div>
          <div className="resource-card-actions">
            {onOpenStore && <button className="btn btn-ghost btn-sm" onClick={onOpenStore}>去商店挑选</button>}
            {source.account
              ? <button className="btn btn-ghost btn-sm" onClick={() => void disconnect(source)}>断开</button>
              : login?.state !== "pending" && <button className="btn btn-primary btn-sm" disabled={busy === source.id} onClick={() => void connect(source)}>{busy === source.id ? "连接中..." : "连接官网账号"}</button>}
          </div>
        </div>
        {login?.state === "pending" && !source.account && <div className="store-login">
          <div>
            <span>授权码</span>
            <code className="store-user-code">{login.userCode}</code>
          </div>
          <p>已在浏览器打开官网授权页，核对授权码一致后点「确认」，这里会自动连上。浏览器没打开的话<a href={login.verificationUriComplete} target="_blank" rel="noreferrer">点这里打开</a>。</p>
          <button className="btn btn-ghost btn-sm" onClick={() => void connect(source)}>换一个授权码</button>
        </div>}
        {login && (login.state === "expired" || login.state === "denied" || login.state === "error") && !source.account && <div className="resource-tab-note warn">{login.message ?? "连接没有完成"}，可以重新点「连接官网账号」。</div>}
      </section>;
    })}
  </>;
}
