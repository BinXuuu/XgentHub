import { shouldGate } from "./riskPolicy.ts";
import { listResourceLibraryItems } from "../services/resourceLibraryService.ts";
import type { AgentAdapter, TaskRuntimeContext, TurnInput } from "./types.ts";
import { runtimeKeyOf } from "./types.ts";

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Mock adapter：不连接任何真实 runtime，用于演示完整的任务生命周期
// （日志 -> 终端输出 -> 文件改动/diff -> 高风险命令审批 -> 完成），
// 也是开发/演示 UI 时最稳定的“黄金路径”。
export class MockAdapter implements AgentAdapter {
  readonly kind = "mock" as const;
  readonly name = "Mock Agent";
  readonly description = "本地模拟 agent，用于演示/开发，不依赖任何外部程序";

  isConfigured() {
    return true;
  }
  configHint() {
    return "开箱即用，无需配置";
  }
  async discoverWorkspaces() {
    return [];
  }

  async run(ctx: TaskRuntimeContext, input: TurnInput): Promise<void> {
    const prompt = input.text;
    ctx.setSessionKey(`mock-${runtimeKeyOf(ctx)}`);
    ctx.log(`收到任务：${prompt}`);
    if (input.images.length) ctx.log(`（mock 不解析图片内容，仅记录收到 ${input.images.length} 张附件）`);
    await sleep(300);

    ctx.log("规划步骤：1) 阅读相关文件 2) 修改代码 3) 运行测试");
    await sleep(300);

    ctx.terminal(`$ rg -l "${prompt.slice(0, 20)}" ${ctx.workspacePath}\n`);
    await sleep(200);
    ctx.terminal(`src/index.ts\nsrc/utils/helper.ts\n`);
    await sleep(300);

    ctx.fileChange(
      "src/utils/helper.ts",
      "modified",
      `--- a/src/utils/helper.ts\n+++ b/src/utils/helper.ts\n@@ -1,3 +1,6 @@\n export function helper() {\n-  return 1;\n+  // 根据任务需求调整返回值\n+  return 2;\n }\n`
    );
    ctx.agentMessage("已定位到 `src/utils/helper.ts`，我先做了一个小的修改用于演示 diff 视图。");
    await sleep(400);

    ctx.terminal(`$ npm test\n`);
    await sleep(500);
    ctx.terminal(`PASS  src/utils/helper.test.ts\n\n1 passed, 0 failed\n`);
    await sleep(300);

    let installDenied = false;
    if (shouldGate("medium", ctx.permissionMode)) {
      ctx.log("准备执行安装依赖命令，这属于中风险操作，进入审批队列");
      const install = await ctx.requestApproval({
        command: "npm install left-pad",
        cwd: ctx.workspacePath,
        riskLevel: "medium",
        reason: "安装新的第三方依赖",
      });
      installDenied = install.decision === "deny";
      if (installDenied) {
        ctx.agentMessage(`已放弃安装依赖（原因：${install.note ?? "用户拒绝"}），改为使用内置实现。`);
      }
    } else {
      ctx.log(`权限等级 "${ctx.permissionMode}"：跳过中风险审批，直接安装依赖`);
    }
    if (!installDenied) {
      ctx.terminal(`$ npm install left-pad\n`);
      await sleep(400);
      ctx.terminal(`added 1 package in 0.8s\n`);
      ctx.agentMessage("依赖安装完成。");
    }
    await sleep(300);

    let pushDenied = false;
    let pushNote: string | null = null;
    if (shouldGate("high", ctx.permissionMode)) {
      ctx.log("准备提交并推送改动，这属于高风险操作，进入审批队列");
      const push = await ctx.requestApproval({
        command: "git push origin main",
        cwd: ctx.workspacePath,
        riskLevel: "high",
        reason: "会把提交推送到远端仓库",
      });
      pushDenied = push.decision === "deny";
      pushNote = push.note;
    } else {
      ctx.log(`权限等级 "${ctx.permissionMode}"：跳过高风险审批，直接推送`);
    }

    if (pushDenied) {
      ctx.agentMessage(`已跳过 git push（原因：${pushNote ?? "用户拒绝"}），改动仍保留在本地工作区。`);
      ctx.setStatus("review");
    } else {
      ctx.terminal(`$ git push origin main\n`);
      await sleep(500);
      ctx.terminal(`To local/mock-repo.git\n   1a2b3c4..5d6e7f8  main -> main\n`);
      ctx.agentMessage("任务完成：代码已修改、测试通过并推送。");
      ctx.setStatus("done");
    }
  }

  async continueTask(ctx: TaskRuntimeContext, input: TurnInput): Promise<void> {
    ctx.log(`收到追加消息：${input.text}`);
    await sleep(300);
    ctx.agentMessage(`（mock）已收到你的补充："${input.text}"。这是一个模拟回复，用于演示继续对话。`);
    ctx.setStatus("review");
  }

  async stop(ctx: TaskRuntimeContext): Promise<void> {
    ctx.log("收到停止请求");
    ctx.setStatus("stopped");
  }

  /**
   * 返回一个固定的示例规划 JSON，方便联调"AI 智能拆分"功能不依赖真实 CLI/网络。
   * 如果资源库里真的有技能条目，第二条子任务会带上第一个技能的 id——这样不管是自动化测试
   * 还是手动在界面上用 Mock Agent 演示，都能真实跑一遍"技能内容被注入子任务 prompt"这条路径，
   * 而不是永远只验证 skillIds 恒为空数组的情况。
   */
  async ask(prompt: string): Promise<string | null> {
    const skills = listResourceLibraryItems("skill");
    const demoSkillIds = skills.length > 0 ? [skills[0]!.id] : [];
    return JSON.stringify({
      subtasks: [
        { title: "梳理需求与素材", description: "（mock）拆解用户请求，列出需要的素材和信息", agentId: "mock", skillIds: [], dependsOn: [], prompt },
        { title: "执行核心工作", description: "（mock）完成主要产出", agentId: "mock", skillIds: demoSkillIds, dependsOn: [1, 2, 99], prompt },
      ],
      reasoning: "这是 Mock Agent 返回的示例规划，仅用于开发联调。",
    });
  }
}
