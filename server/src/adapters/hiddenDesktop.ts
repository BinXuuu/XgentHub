import { execFileSync, spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { config } from "../config.ts";

// Windows 上有的 CLI（Antigravity 的 agy）会自己再拉起后台更新、MCP 服务、执行命令用的 PowerShell / cmd，
// 这些子进程新开控制台时我们的 windowsHide 管不到，屏幕上会一闪一个黑框。
// 办法：用一个小启动器先建一个看不见的桌面，再把 CLI 启动在那个桌面上——它和它所有子进程的窗口都只出现在那里。
// 输出通过管道照常传回。CLI 结束后它留下的进程（比如 Agent 帮你开着的开发服务器）照常保留，只是在看不见的桌面上；
// 停止 / 超时时用 killHiddenTree（taskkill /T）把启动器连同整棵子进程树结束。
// 启动器第一次用到时用系统自带的 .NET 编译器现场编译（Add-Type），按源码哈希缓存；编译不了就退回普通方式。

const LAUNCHER_SOURCE = String.raw`
using System;
using System.ComponentModel;
using System.IO;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public static class XgentHiddenRun {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  struct STARTUPINFO {
    public int cb; public string lpReserved; public string lpDesktop; public string lpTitle;
    public int dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags;
    public short wShowWindow, cbReserved2; public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError;
  }
  [StructLayout(LayoutKind.Sequential)]
  struct STARTUPINFOEX { public STARTUPINFO StartupInfo; public IntPtr lpAttributeList; }
  [StructLayout(LayoutKind.Sequential)]
  struct PROCESS_INFORMATION { public IntPtr hProcess, hThread; public int dwProcessId, dwThreadId; }

  [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  static extern IntPtr CreateDesktop(string name, IntPtr device, IntPtr devmode, int flags, uint access, IntPtr sa);
  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  static extern bool CreateProcess(string app, StringBuilder cmd, IntPtr pa, IntPtr ta, bool inherit, uint flags, IntPtr env, string cwd, ref STARTUPINFOEX si, out PROCESS_INFORMATION pi);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, int flags, ref IntPtr size);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, IntPtr attribute, IntPtr value, IntPtr size, IntPtr previous, IntPtr returnSize);
  [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int n);
  [DllImport("kernel32.dll")] static extern bool SetHandleInformation(IntPtr h, uint mask, uint flags);
  [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr h, uint ms);
  [DllImport("kernel32.dll")] static extern bool GetExitCodeProcess(IntPtr h, out uint code);

  static string Decode(string b64) { return Encoding.UTF8.GetString(Convert.FromBase64String(b64)); }

  public static int Main(string[] args) {
    if (args.Length < 2) { Console.Error.WriteLine("usage: xgent-hidden-run <cwd-base64> <commandline-base64>"); return 2; }
    string cwd = Decode(args[0]);
    string commandLine = Decode(args[1]);

    // 看不见的桌面：同名的已存在就直接打开。建不了（比如权限不够）就在当前桌面上照常启动。
    IntPtr desktop = CreateDesktop("XgentHiddenDesktop", IntPtr.Zero, IntPtr.Zero, 0, 0x10000000u, IntPtr.Zero);

    // 输出走启动器自己建的管道再转发：程序结束后留下的进程就算还拿着管道，也不会让 Xgent 一直等「输出结束」。
    var outPipe = new AnonymousPipeServerStream(PipeDirection.In, HandleInheritability.Inheritable);
    var errPipe = new AnonymousPipeServerStream(PipeDirection.In, HandleInheritability.Inheritable);
    var six = new STARTUPINFOEX();
    var si = new STARTUPINFO();
    si.cb = Marshal.SizeOf(typeof(STARTUPINFOEX));
    si.lpDesktop = desktop != IntPtr.Zero ? "XgentHiddenDesktop" : null;
    si.dwFlags = 0x100 | 0x1; // STARTF_USESTDHANDLES | STARTF_USESHOWWINDOW
    si.wShowWindow = 0;       // SW_HIDE
    // 启动器自己的标准句柄（Xgent 那边的管道）设成不可继承，不然会被子进程和它留下的进程继承，管道就一直关不掉。
    foreach (int n in new[] { -10, -11, -12 }) { IntPtr h = GetStdHandle(n); if (h != IntPtr.Zero && h != new IntPtr(-1)) SetHandleInformation(h, 1, 0); }
    // 子进程没有输入（提示词都在参数里）：给它一根马上关掉写端的空管道。
    var inPipe = new AnonymousPipeServerStream(PipeDirection.Out, HandleInheritability.Inheritable);
    si.hStdInput = inPipe.ClientSafePipeHandle.DangerousGetHandle();
    si.hStdOutput = outPipe.ClientSafePipeHandle.DangerousGetHandle();
    si.hStdError = errPipe.ClientSafePipeHandle.DangerousGetHandle();

    // 只让子进程继承这三根管道（PROC_THREAD_ATTRIBUTE_HANDLE_LIST）。只靠「设成不可继承」不够：
    // 启动器从 Xgent 拿到的管道句柄还是会被继承下去，Agent 留下的后台进程拿着它，Xgent 就一直等不到输出结束。
    IntPtr[] handles = { si.hStdInput, si.hStdOutput, si.hStdError };
    IntPtr handleList = Marshal.AllocHGlobal(IntPtr.Size * handles.Length);
    Marshal.Copy(handles, 0, handleList, handles.Length);
    IntPtr size = IntPtr.Zero;
    InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref size);
    IntPtr attributes = Marshal.AllocHGlobal(size);
    if (!InitializeProcThreadAttributeList(attributes, 1, 0, ref size)
        || !UpdateProcThreadAttribute(attributes, 0, new IntPtr(0x20002), handleList, new IntPtr(IntPtr.Size * handles.Length), IntPtr.Zero, IntPtr.Zero)) {
      Console.Error.WriteLine("xgent-hidden-run: cannot limit inherited handles: " + new Win32Exception(Marshal.GetLastWin32Error()).Message);
      return 9009;
    }
    six.StartupInfo = si;
    six.lpAttributeList = attributes;

    PROCESS_INFORMATION pi;
    uint flags = 0x08000000 | 0x00080000; // CREATE_NO_WINDOW | EXTENDED_STARTUPINFO_PRESENT
    if (!CreateProcess(null, new StringBuilder(commandLine), IntPtr.Zero, IntPtr.Zero, true, flags, IntPtr.Zero, cwd, ref six, out pi)) {
      Console.Error.WriteLine("xgent-hidden-run: cannot start process: " + new Win32Exception(Marshal.GetLastWin32Error()).Message);
      return 9009;
    }
    inPipe.DisposeLocalCopyOfClientHandle();
    inPipe.Dispose();
    outPipe.DisposeLocalCopyOfClientHandle();
    errPipe.DisposeLocalCopyOfClientHandle();
    Stream stdout = Console.OpenStandardOutput();
    Stream stderr = Console.OpenStandardError();
    Thread outThread = Pump(outPipe, stdout);
    Thread errThread = Pump(errPipe, stderr);

    WaitForSingleObject(pi.hProcess, 0xFFFFFFFF);
    // 程序已经结束：把剩下的输出读完（最多等 1 秒，残留进程拿着管道时不会一直等）。
    outThread.Join(1000);
    errThread.Join(1000);
    uint code;
    GetExitCodeProcess(pi.hProcess, out code);
    try { stdout.Flush(); stderr.Flush(); } catch { }
    Environment.Exit((int)code);
    return (int)code;
  }

  static Thread Pump(Stream from, Stream to) {
    var thread = new Thread(() => {
      var buffer = new byte[8192];
      try {
        int read;
        while ((read = from.Read(buffer, 0, buffer.Length)) > 0) { to.Write(buffer, 0, read); to.Flush(); }
      } catch { }
    });
    thread.IsBackground = true;
    thread.Start();
    return thread;
  }
}
`;

const LAUNCHER_HASH = crypto.createHash("sha256").update(LAUNCHER_SOURCE).digest("hex").slice(0, 12);
let launcherState: { path: string | null; error: string | null } | null = null;

/** Windows 命令行参数的引号规则（CommandLineToArgvW）：带空格 / 引号 / 空串的参数包一层引号，引号和它前面的反斜杠转义。 */
export function quoteWindowsArg(value: string): string {
  if (value && !/[\s"]/.test(value)) return value;
  return `"${value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, "$1$1")}"`;
}

function psLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/** 启动器 exe 的路径；第一次调用时编译（一两秒），之后直接用缓存。非 Windows 或编译失败返回 null。 */
export function hiddenLauncherPath(): string | null {
  if (process.platform !== "win32") return null;
  if (launcherState) return launcherState.path;
  const dir = path.join(config.dataDir, "bin");
  const exe = path.join(dir, `xgent-hidden-run-${LAUNCHER_HASH}.exe`);
  if (fs.existsSync(exe)) {
    launcherState = { path: exe, error: null };
    return exe;
  }
  // 在目标目录里编译再改名：临时目录和数据目录可能不在同一个盘，跨盘不能直接改名。
  fs.mkdirSync(dir, { recursive: true });
  const work = fs.mkdtempSync(path.join(dir, ".build-"));
  try {
    const source = path.join(work, "XgentHiddenRun.cs");
    fs.writeFileSync(source, LAUNCHER_SOURCE, "utf8");
    const built = path.join(work, "launcher.exe");
    const script = `$ErrorActionPreference = 'Stop'; Add-Type -TypeDefinition (Get-Content -Raw -Encoding UTF8 -LiteralPath ${psLiteral(source)}) -Language CSharp -ReferencedAssemblies System.Core -OutputAssembly ${psLiteral(built)} -OutputType ConsoleApplication`;
    execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script], { windowsHide: true, timeout: 120_000, stdio: "pipe" });
    fs.renameSync(built, exe);
    launcherState = { path: exe, error: null };
  } catch (err) {
    launcherState = { path: null, error: (err as Error).message };
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
  return launcherState.path;
}

export function hiddenLauncherError(): string | null {
  return launcherState?.error ?? null;
}

/**
 * 在看不见的桌面上启动一个 .exe（只接受真正的 exe，不处理 .cmd / .ps1 包装）。
 * 返回的是启动器进程：stdout / stderr / 退出码都是被启动程序的。要结束它请用 killProcessTree（taskkill /T），
 * 只 kill 启动器的话被启动的程序会留下来。
 * 用不了（非 Windows、不是 exe、启动器编译失败）时返回 null，调用方照常启动。
 */
export function spawnOnHiddenDesktop(exe: string, args: string[], opts: { cwd: string; env?: NodeJS.ProcessEnv }): ChildProcess | null {
  // 设 XGENT_DISABLE_HIDDEN_DESKTOP=1 可以关掉（比如杀毒软件拦了启动器），退回普通的隐藏窗口启动。
  if (process.platform !== "win32" || !/\.exe$/i.test(exe) || process.env.XGENT_DISABLE_HIDDEN_DESKTOP === "1") return null;
  const launcher = hiddenLauncherPath();
  if (!launcher) return null;
  const commandLine = [exe, ...args].map(quoteWindowsArg).join(" ");
  const b64 = (value: string) => Buffer.from(value, "utf8").toString("base64");
  return nodeSpawn(launcher, [b64(opts.cwd), b64(commandLine)], { cwd: opts.cwd, env: opts.env, windowsHide: true });
}
