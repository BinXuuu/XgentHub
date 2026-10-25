Set WshShell = CreateObject("WScript.Shell")
Set FSO = CreateObject("Scripting.FileSystemObject")

root = FSO.GetParentFolderName(FSO.GetParentFolderName(FSO.GetParentFolderName(WScript.ScriptFullName)))
electron = root & "\node_modules\electron\dist\electron.exe"
main = root & "\desktop\main.cjs"

If Not FSO.FileExists(electron) Then
  MsgBox "Xgent Hub desktop runtime is missing." & vbCrLf & vbCrLf & _
    "Please run install.bat in this folder, then open Xgent Hub again:" & vbCrLf & root, _
    vbExclamation, "Xgent Hub"
  WScript.Quit 1
End If

If Not FSO.FileExists(main) Then
  MsgBox "Xgent Hub desktop entry is missing:" & vbCrLf & main, vbExclamation, "Xgent Hub"
  WScript.Quit 1
End If

WshShell.Environment("PROCESS")("XGENT_HUB_ROOT") = root
cmd = """" & electron & """ """ & main & """"
WshShell.Run cmd, 0, False
