import { useState, type FormEvent } from "react";
import { api } from "../api/client";
import type { GithubSkillCandidate, GithubSkillPreview, SkillGroup } from "../api/types";

function size(bytes: number) {
  return bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function licenseClass(skill: GithubSkillCandidate) {
  return skill.openLicense === true ? "ok" : skill.openLicense === false ? "danger" : "warn";
}

/** 粘贴 GitHub 链接 → 列出仓库里的 Skill（含许可证）→ 勾选安装到技能库。 */
export function GithubSkillInstaller({ groups, onDone, onClose }: { groups: SkillGroup[]; onDone: (message: string) => Promise<void>; onClose: () => void }) {
  const [url, setUrl] = useState("");
  const [preview, setPreview] = useState<GithubSkillPreview | null>(null);
  const [picked, setPicked] = useState<string[]>([]);
  const [groupId, setGroupId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function load(event: FormEvent) {
    event.preventDefault();
    setBusy(true); setError(""); setPreview(null);
    try {
      const result = await api.previewGithubSkills(url);
      setPreview(result);
      // 默认勾选还没装过、许可证不是专有的；仓库只有一个 Skill 时直接选上。
      setPicked(result.skills.length === 1 ? [result.skills[0]!.path] : result.skills.filter((skill) => !skill.installed && skill.openLicense !== false).map((skill) => skill.path));
    } catch (err) { setError((err as Error).message); }
    finally { setBusy(false); }
  }

  async function install() {
    if (!preview) return;
    setBusy(true); setError("");
    try {
      const result = await api.installGithubSkills({ url, paths: picked, groupId: groupId || null });
      const parts = [result.installed && `新装 ${result.installed} 个`, result.updated && `更新 ${result.updated} 个`].filter(Boolean).join("，");
      await onDone(`已从 ${preview.repo} ${parts || "安装 0 个"} Skill。${result.warnings.length ? ` 提示：${result.warnings.join("；")}` : ""}`);
      onClose();
    } catch (err) { setError((err as Error).message); }
    finally { setBusy(false); }
  }

  const all = preview?.skills ?? [];
  const pickedRestricted = all.filter((skill) => picked.includes(skill.path) && skill.openLicense === false);
  return <section className="github-skill-installer">
    <div className="github-skill-head"><h4>从 GitHub 安装 Skill</h4><button className="btn btn-ghost btn-sm" type="button" onClick={onClose}>关闭</button></div>
    <form className="github-skill-url" onSubmit={load}>
      <input className="field" aria-label="GitHub 链接" placeholder="https://github.com/anthropics/skills" required value={url} onChange={(event) => setUrl(event.target.value)} />
      <button className="btn" disabled={busy || !url.trim()}>{busy && !preview ? "读取中..." : "读取"}</button>
    </form>
    <span className="config-field-help">支持仓库首页、某个目录（/tree/…）或 SKILL.md 文件的链接。只下载文件到 Xgent 的数据目录，不会运行里面的脚本；Skill 需要的运行依赖和外部服务要另外配置。</span>
    {error && <div className="form-error" role="alert">{error}</div>}
    {preview && <>
      <div className="skill-batch-toolbar">
        <label><input type="checkbox" aria-label="全选" checked={all.length > 0 && picked.length === all.length} onChange={() => setPicked(picked.length === all.length ? [] : all.map((skill) => skill.path))} /> {preview.repo} · 找到 {all.length} 个</label>
        <span>已选 {picked.length}</span>
        <select className="field" aria-label="安装到哪个组" value={groupId} onChange={(event) => setGroupId(event.target.value)}>
          <option value="">按仓库自动建组</option>
          {groups.map((group) => <option value={group.id} key={group.id}>{group.name}</option>)}
        </select>
      </div>
      {preview.warnings.map((warning) => <div className="resource-tab-note" key={warning}>{warning}</div>)}
      <div className="github-skill-list">
        {all.map((skill) => <label className={`github-skill-row${picked.includes(skill.path) ? " selected" : ""}`} key={skill.path}>
          <input type="checkbox" checked={picked.includes(skill.path)} aria-label={`选择 ${skill.name}`}
            onChange={() => setPicked((paths) => paths.includes(skill.path) ? paths.filter((value) => value !== skill.path) : [...paths, skill.path])} />
          <div>
            <div className="github-skill-title"><strong>{skill.name}</strong>
              <span className={`license-badge ${licenseClass(skill)}`} title={skill.openLicense === false ? "专有许可：只能按原作者的条款使用，不要转发或商用" : undefined}>{skill.license}</span>
              {skill.installed && <span className="license-badge neutral">已安装，再装会更新</span>}
            </div>
            <p>{skill.description || "（没有写说明）"}</p>
            <span className="github-skill-meta">{skill.path || "仓库根目录"} · {skill.files} 个文件 · {size(skill.bytes)}</span>
          </div>
        </label>)}
      </div>
      {pickedRestricted.length > 0 && <div className="resource-tab-note warn">选中的 {pickedRestricted.map((skill) => skill.name).join("、")} 是专有许可，只能按原作者的条款自己使用，不要转发或商用。</div>}
      <div className="resource-card-actions"><button className="btn btn-primary btn-sm" type="button" disabled={busy || !picked.length} onClick={() => void install()}>{busy ? "安装中..." : `安装 ${picked.length} 个`}</button></div>
    </>}
  </section>;
}
