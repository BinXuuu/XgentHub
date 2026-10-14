' 在完全没有窗口的情况下拉起 AgentHub，标准输出/错误重定向到 logs\agenthub-dev.log。
' 用法：wscript.exe //B run-hidden.vbs "<项目根目录>"
Set WshShell = CreateObject("WScript.Shell")
projectRoot = WScript.Arguments(0)
WshShell.CurrentDirectory = projectRoot
WshShell.Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & projectRoot & "\scripts\agenthub.ps1"" start -Mode dev -NoWait", 0, False
