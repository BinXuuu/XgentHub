import { spawn } from "node:child_process";

// 用原生 Windows 文件夹选择框（System.Windows.Forms.FolderBrowserDialog）代替手填路径。
// Xgent Hub 明确是"本机"工具——浏览器和这个后端跑在同一台机器上，所以可以直接在服务端
// 拉起一个系统级对话框给用户选；这在纯 Web 场景下做不到（浏览器出于安全限制，
// <input type="file" webkitdirectory> 拿不到绝对路径），但本机场景下这样做是合理的。
const FOLDER_PICKER_SCRIPT = `
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Windows.Forms | Out-Null
Add-Type -AssemblyName System.Drawing | Out-Null
Add-Type -Name Win32Foreground -Namespace AgentHub -MemberDefinition '[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);'

# 从 Node 子进程拉起的对话框默认不会抢前台焦点，只能靠 Alt+Tab 才能看到。
# 这里用一个隐形的、TopMost 的宿主窗口当 owner，再配合 SetForegroundWindow 把它顶到最前面。
$owner = New-Object System.Windows.Forms.Form
$owner.StartPosition = 'CenterScreen'
$owner.Size = New-Object System.Drawing.Size(0, 0)
$owner.FormBorderStyle = 'None'
$owner.ShowInTaskbar = $false
$owner.TopMost = $true
$owner.Show()
$owner.Activate()
[AgentHub.Win32Foreground]::SetForegroundWindow($owner.Handle) | Out-Null

$dialog = New-Object System.Windows.Forms.FolderBrowserDialog
$dialog.Description = '选择 Xgent Hub 工作区目录'
$dialog.ShowNewFolderButton = $true
$result = $dialog.ShowDialog($owner)
$owner.Close()
if ($result -eq [System.Windows.Forms.DialogResult]::OK) {
  Write-Output $dialog.SelectedPath
}
`;

const CONFIG_BUNDLE_PICKER_SCRIPT = `
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Windows.Forms | Out-Null
Add-Type -AssemblyName System.Drawing | Out-Null
Add-Type -Name Win32Foreground -Namespace AgentHub -MemberDefinition '[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);'

$owner = New-Object System.Windows.Forms.Form
$owner.StartPosition = 'CenterScreen'
$owner.Size = New-Object System.Drawing.Size(0, 0)
$owner.FormBorderStyle = 'None'
$owner.ShowInTaskbar = $false
$owner.TopMost = $true
$owner.Show()
$owner.Activate()
[AgentHub.Win32Foreground]::SetForegroundWindow($owner.Handle) | Out-Null

$dialog = New-Object System.Windows.Forms.OpenFileDialog
$dialog.Title = '选择 Xgent Hub 配置包'
$dialog.Filter = 'Xgent Hub 配置包 (*.zip)|*.zip|所有文件 (*.*)|*.*'
$dialog.CheckFileExists = $true
$dialog.Multiselect = $false
$result = $dialog.ShowDialog($owner)
$owner.Close()
if ($result -eq [System.Windows.Forms.DialogResult]::OK) {
  Write-Output $dialog.FileName
}
`;

function runWindowsPicker(script: string, label: string): Promise<string | null> {
  if (process.platform !== "win32") {
    return Promise.reject(new Error(`${label}目前只支持 Windows`));
  }
  return new Promise((resolve, reject) => {
    const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-STA", "-Command", script]);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString("utf8")));
    child.stderr.on("data", (d) => (stderr += d.toString("utf8")));

    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error(`${label}超时（5 分钟未操作）`));
    }, 5 * 60 * 1000);

    child.on("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      const path = stdout.trim();
      if (!path) {
        if (code !== 0 && stderr.trim()) reject(new Error(stderr.trim().slice(0, 500)));
        else resolve(null); // 用户点了取消
        return;
      }
      resolve(path);
    });
  });
}

/** 弹出本机文件夹选择框，返回选中的绝对路径；用户取消则返回 null。仅支持 Windows。 */
export function pickFolderWindows(): Promise<string | null> {
  return runWindowsPicker(FOLDER_PICKER_SCRIPT, "选择文件夹");
}

/** 弹出本机 zip 文件选择框，用于导入 Xgent Hub 配置包；用户取消则返回 null。仅支持 Windows。 */
export function pickConfigBundleWindows(): Promise<string | null> {
  return runWindowsPicker(CONFIG_BUNDLE_PICKER_SCRIPT, "选择配置包");
}
