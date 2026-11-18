import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createResourceLibraryItem, listResourceLibraryItems, listSkillGroups, saveSkillGroup } from "./resourceLibraryService.ts";

const anthropicPlugins: Record<string, string> = {
  productivity: "个人效率", sales: "销售", "customer-support": "客户支持",
  "product-management": "产品管理", marketing: "市场营销", legal: "法务", finance: "财务",
  data: "数据分析", "enterprise-search": "企业搜索", "bio-research": "生物研究",
  "cowork-plugin-management": "插件创建与定制",
};

/** 只接入已安装的指定插件技能，不下载代码、不运行脚本、不安装运行时。参数仅供服务端及隔离测试使用。 */
export function importInstalledPluginSkills(skillsRoot = path.join(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"), "skills")) {
  const result = { imported: 0, skipped: 0, groups: 0, warnings: [] as string[] };
  if (!fs.existsSync(skillsRoot)) throw new Error("未找到本机 Codex Skill 目录");
  const candidates: { title: string; content: string; sourcePath: string; source: string; groupName: string; tags: string[] }[] = [];
  for (const directory of fs.readdirSync(skillsRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory())) {
    const title = directory.name;
    if (!title.startsWith("anthropic-") && !["cinetic", "earshot", "real-sound"].includes(title)) continue;
    try {
      const sourcePath = path.join(skillsRoot, title, "SKILL.md");
      if (!fs.statSync(sourcePath).isFile()) throw new Error("缺少 SKILL.md");
      const metadata = JSON.parse(fs.readFileSync(path.join(skillsRoot, title, "SOURCE.json"), "utf8"));
      const plugin = metadata.plugin as string;
      const isAnthropic = title.startsWith("anthropic-") && Object.hasOwn(anthropicPlugins, plugin)
        && title === `anthropic-${plugin}-${metadata.upstreamName}`;
      const repo = isAnthropic ? "anthropics/knowledge-work-plugins" : metadata.repo;
      if (!isAnthropic && !((title === "cinetic" && repo === "Leonxlnx/cinetic")
        || (["earshot", "real-sound"].includes(title) && repo === "Leonxlnx/earshot"))) throw new Error("来源元数据不匹配");
      const description = metadata.upstreamFrontmatter?.description;
      if (typeof description !== "string" || !description.trim()) throw new Error("缺少技能说明");
      candidates.push({
        title, content: description.trim(), sourcePath: path.resolve(sourcePath),
        source: isAnthropic ? `${repo}/${plugin}` : repo,
        groupName: isAnthropic ? `Anthropic · ${anthropicPlugins[plugin]}` : title === "cinetic" ? "Cinetic · 视频制作" : "Earshot · 音效与音轨",
        tags: isAnthropic ? ["Anthropic", plugin, anthropicPlugins[plugin]!] : [repo.split("/")[1], title === "cinetic" ? "视频" : "音频"],
      });
    } catch (err) {
      result.warnings.push(`${title}：${(err as Error).message}`);
    }
  }
  const key = (value: string) => process.platform === "win32" ? path.resolve(value).toLowerCase() : path.resolve(value);
  const existing = new Map(listResourceLibraryItems("skill").filter((item) => item.sourcePath).map((item) => [key(item.sourcePath!), item]));
  const groups = listSkillGroups();
  const touched = new Set<string>();
  for (const candidate of candidates) {
    const previous = existing.get(key(candidate.sourcePath));
    if (previous) {
      result.skipped++;
      if (previous.groupId) touched.add(previous.groupId);
      continue; // 保留用户编辑过的内容和归组，不因重新导入覆盖。
    }
    let group = groups.find((entry) => entry.source === candidate.source);
    if (!group) {
      const baseName = candidate.groupName;
      let name = baseName;
      for (let n = 2; groups.some((entry) => entry.name.toLowerCase() === name.toLowerCase()); n++) name = `${baseName} (${n})`;
      group = saveSkillGroup({ name, source: candidate.source, description: `来自 ${candidate.source} 的已安装技能。仅接入说明与本机入口，运行依赖和外部连接器需另行配置。` });
      groups.push(group);
    }
    const item = createResourceLibraryItem("skill", { ...candidate, groupId: group.id });
    existing.set(key(candidate.sourcePath), item);
    touched.add(group.id);
    result.imported++;
  }
  result.groups = touched.size;
  if (!candidates.length && !result.warnings.length) result.warnings.push("未找到已安装的 Anthropic、Cinetic 或 Earshot 插件 Skill");
  return result;
}
