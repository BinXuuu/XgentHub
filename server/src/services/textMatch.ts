// 资源库工具和知识库条目共用的"这句话和这条资料相关吗"分词：英文按词，中文按相邻两字切词组，跳过常见虚词。

const LIBRARY_MATCH_STOP_TOKENS = new Set([
  "and",
  "agent",
  "codex",
  "codex-skill",
  "the",
  "for",
  "with",
  "from",
  "into",
  "your",
  "you",
  "use",
  "using",
  "通过",
  "管理",
  "能力",
  "支持",
  "工具",
  "任务",
  "工作",
  "平台",
  "本地",
  "文件",
  "项目",
  "使用",
  "运行",
]);

// 中文里很常见、单独出现说明不了"相关"的两字词，比对时跳过。
const CJK_STOP_BIGRAMS = new Set([
  "帮我",
  "一下",
  "这个",
  "那个",
  "我们",
  "你们",
  "可以",
  "需要",
  "怎么",
  "什么",
  "现在",
  "然后",
  "如果",
  "一个",
  "看看",
  "开始",
  "继续",
  "上面",
  "下面",
  "按照",
  "执行",
]);

/** 英文按词；中文不分词，按相邻两字切成词组（"代码审查" → 代码、码审、审查），部分重合也能比对上。 */
export function tokenizeForMatch(text: string): { latin: string[]; cjk: string[] } {
  const lower = text.toLowerCase();
  const latin = (lower.match(/[a-z0-9_\-.]{3,}/g) ?? []).filter((token) => !LIBRARY_MATCH_STOP_TOKENS.has(token));
  const cjk: string[] = [];
  for (const run of lower.match(/[一-鿿]+/g) ?? []) {
    for (let i = 0; i + 1 < run.length; i++) {
      const bigram = run.slice(i, i + 2);
      if (!CJK_STOP_BIGRAMS.has(bigram) && !LIBRARY_MATCH_STOP_TOKENS.has(bigram)) cjk.push(bigram);
    }
  }
  return { latin: [...new Set(latin)].slice(0, 60), cjk: [...new Set(cjk)].slice(0, 120) };
}

