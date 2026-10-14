' Hidden launcher for Windows Task Scheduler.
Set WshShell = CreateObject("WScript.Shell")
Set FSO = CreateObject("Scripting.FileSystemObject")

root = FSO.GetParentFolderName(WScript.ScriptFullName)
script = root & "\start-on-login.ps1"
cmd = "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & script & """"

WshShell.Run cmd, 0, False
