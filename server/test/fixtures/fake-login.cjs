// 假的登录命令，输出格式照 2026-11-10 在测试电脑上实测的 codex login / claude auth login（输出接管道时）。
// 用法：fake-login.cjs codex|claude|fail
const mode = process.argv[2];
if (mode === "codex") {
  process.stderr.write("Starting local login server on http://localhost:1455.\nIf your browser did not open, navigate to this URL to authenticate:\n\n");
  process.stderr.write("https://auth.openai.com/oauth/authorize?response_type=code&client_id=x&redirect_uri=http%3A%2F%2F127.0.0.1%3A1455%2Fauth%2Fcallback&state=s\n\n");
  setTimeout(() => process.exit(0), 300); // 浏览器里登录完成，本机回调收到后命令自己结束
} else if (mode === "claude") {
  process.stdout.write("Opening browser to sign in…\nIf the browser didn't open, visit: https://claude.com/cai/oauth/authorize?code=true&client_id=x&state=s\nPaste code here if prompted > ");
  let input = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    input += chunk;
    if (!input.includes("\n")) return;
    if (input.trim() === "good-code") {
      process.stdout.write("\nLogin successful.\n");
      process.exit(0);
    }
    // 2026-11-10 实测：验证码不对时 stderr 打这句；直连被 Anthropic 拒绝（没走代理）时打 403。
    if (input.trim() === "blocked") process.stderr.write("Login failed: Request failed with status code 403\n");
    else process.stderr.write("Login failed: That code wasn't accepted. It may be incomplete, expired, already used, or from an earlier sign-in attempt. Sign in again to get a new code.\n");
    process.exit(1);
  });
} else {
  process.stderr.write("something went wrong\n");
  process.exit(3);
}
