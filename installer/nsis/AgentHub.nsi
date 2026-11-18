Unicode true
!include "MUI2.nsh"
!include "LogicLib.nsh"
!include "FileFunc.nsh"

!ifndef APP_VERSION
  !define APP_VERSION "0.0.0"
!endif
!define UNINSTALL_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\XgentHub"

!ifndef OUTPUT_EXE
  !define OUTPUT_EXE "XgentHubSetup.exe"
!endif

!ifndef RELEASE_ZIP
  !error "RELEASE_ZIP is required. Build through scripts\build-nsis-installer.ps1."
!endif

!ifndef RELEASE_REPORT
  !error "RELEASE_REPORT is required. Build through scripts\build-nsis-installer.ps1."
!endif

!ifndef APP_ICON
  !define APP_ICON "${NSISDIR}\Contrib\Graphics\Icons\modern-install.ico"
!endif

Name "Xgent Hub ${APP_VERSION}"
BrandingText "Xgent Hub ${APP_VERSION}"
OutFile "${OUTPUT_EXE}"
InstallDir "$LOCALAPPDATA\Programs\Xgent Hub"
RequestExecutionLevel user
ShowInstDetails show
ShowUninstDetails show

!define MUI_ABORTWARNING
!define MUI_ICON "${APP_ICON}"
!define MUI_UNICON "${APP_ICON}"

!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_COMPONENTS
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH

!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES

!insertmacro MUI_LANGUAGE "SimpChinese"
!insertmacro MUI_LANGUAGE "English"

VIProductVersion "${APP_VERSION}.0"
VIAddVersionKey /LANG=${LANG_SIMPCHINESE} "ProductName" "Xgent Hub"
VIAddVersionKey /LANG=${LANG_SIMPCHINESE} "FileDescription" "Xgent Hub 安装程序"
VIAddVersionKey /LANG=${LANG_SIMPCHINESE} "FileVersion" "${APP_VERSION}"
VIAddVersionKey /LANG=${LANG_SIMPCHINESE} "ProductVersion" "${APP_VERSION}"

Section "Xgent Hub 程序文件（必选）" SEC_CORE
  SectionIn RO
  SetOutPath "$INSTDIR"

  ; 覆盖安装（升级）前先停掉正在运行的服务和桌面窗口，不然文件被占用替换不了。数据和设置不动。
  IfFileExists "$INSTDIR\scripts\agenthub.ps1" 0 coreNoRunning
    DetailPrint "正在停止已运行的 Xgent Hub..."
    nsExec::ExecToLog 'powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$INSTDIR\scripts\agenthub.ps1" stop'
    Pop $0
    nsExec::ExecToLog "powershell.exe -NoProfile -ExecutionPolicy Bypass -Command $\"Get-Process | Where-Object { $$_.Path -and $$_.Path.StartsWith('$INSTDIR\', [StringComparison]::OrdinalIgnoreCase) } | Stop-Process -Force -ErrorAction SilentlyContinue$\""
    Pop $0
coreNoRunning:

  File /oname=AgentHub-release.zip "${RELEASE_ZIP}"
  File /oname=AgentHub-release.release-check.json "${RELEASE_REPORT}"

  DetailPrint "正在解压程序文件（几千个文件，需要一两分钟）..."
  ; Windows 10 起自带的 tar.exe 解压 zip 比 Expand-Archive 快得多；没有时退回 Expand-Archive。
  IfFileExists "$SYSDIR\tar.exe" 0 coreExpandArchive
    nsExec::ExecToLog '"$SYSDIR\tar.exe" -x -f "$INSTDIR\AgentHub-release.zip" -C "$INSTDIR"'
    Pop $0
    Goto coreExtracted
coreExpandArchive:
  nsExec::ExecToLog "powershell.exe -NoProfile -ExecutionPolicy Bypass -Command $\"Expand-Archive -LiteralPath '$INSTDIR\AgentHub-release.zip' -DestinationPath '$INSTDIR' -Force$\""
  Pop $0
coreExtracted:
  ${If} $0 != 0
    IfSilent coreExtractAbort
    MessageBox MB_ICONSTOP "解压程序文件失败（错误码 $0）。请确认磁盘空间足够，或者换个安装位置再试。"
coreExtractAbort:
    Abort
  ${EndIf}

  Delete "$INSTDIR\AgentHub-release.zip"

  DetailPrint "正在初始化（生成本机登录令牌和数据目录）..."
  nsExec::ExecToLog 'cmd.exe /C ""$INSTDIR\install.bat""'
  Pop $0
  ${If} $0 != 0
    IfSilent coreInstallAbort
    MessageBox MB_ICONEXCLAMATION "初始化没有完全成功（错误码 $0）。可以在安装目录运行 xgent.bat doctor 查看原因。"
    Goto coreInstallWarningDone
coreInstallAbort:
    Abort
coreInstallWarningDone:
  ${EndIf}

  WriteUninstaller "$INSTDIR\Uninstall.exe"

  ; 登记到「设置 → 应用」，可以从那里卸载。
  WriteRegStr HKCU "${UNINSTALL_KEY}" "DisplayName" "Xgent Hub"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "DisplayVersion" "${APP_VERSION}"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "Publisher" "Xgent"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "DisplayIcon" "$INSTDIR\desktop\assets\xgent-hub.ico"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "UninstallString" '"$INSTDIR\Uninstall.exe"'
  WriteRegDWORD HKCU "${UNINSTALL_KEY}" "NoModify" 1
  WriteRegDWORD HKCU "${UNINSTALL_KEY}" "NoRepair" 1
SectionEnd

Section "桌面和开始菜单快捷方式" SEC_SHORTCUTS
  ; 命令行带 /NOSHORTCUTS 时不建快捷方式（自动化测试、批量部署用）。
  ${GetParameters} $R0
  ClearErrors
  ${GetOptions} $R0 "/NOSHORTCUTS" $R1
  ${IfNot} ${Errors}
    DetailPrint "按 /NOSHORTCUTS 跳过快捷方式"
  ${Else}
    DetailPrint "正在创建快捷方式..."
    ExecWait 'powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$INSTDIR\scripts\installer-entry.ps1" install-shortcuts'
  ${EndIf}
SectionEnd

Section /o "开机登录后自动启动" SEC_STARTUP
  DetailPrint "正在设置开机自动启动..."
  ExecWait 'powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$INSTDIR\scripts\installer-entry.ps1" install-startup'
SectionEnd

Section "安装完成后打开 Xgent Hub" SEC_START
  ; 静默安装（/S）不自动打开，留给调用方决定。
  IfSilent startSkip
  DetailPrint "正在打开 Xgent Hub..."
  Exec 'powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "$INSTDIR\scripts\installer-entry.ps1" start-app'
startSkip:
SectionEnd

Section "Uninstall"
  DeleteRegKey HKCU "${UNINSTALL_KEY}"
  DetailPrint "正在停止 Xgent Hub..."
  IfFileExists "$INSTDIR\scripts\agenthub.ps1" 0 un_skipStop
    ExecWait 'powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$INSTDIR\scripts\agenthub.ps1" stop'
un_skipStop:

  DetailPrint "Removing Xgent Hub startup task and shortcuts..."
  IfFileExists "$INSTDIR\scripts\installer-entry.ps1" 0 un_skipInstallerEntry
    ExecWait 'powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$INSTDIR\scripts\installer-entry.ps1" remove-startup'
    ExecWait 'powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$INSTDIR\scripts\installer-entry.ps1" remove-shortcuts'
un_skipInstallerEntry:

  IfSilent un_keepData
  MessageBox MB_YESNO|MB_ICONQUESTION "要不要连本机的设置、任务记录、日志和备份一起删除？$\r$\n$\r$\n选「是」：全部删除。$\r$\n选「否」：只删程序文件，数据保留在：$\r$\n$INSTDIR" IDYES un_fullCleanup IDNO un_keepData

un_keepData:
  DetailPrint "Removing Xgent Hub program files and keeping local data..."

  IfFileExists "$INSTDIR\scripts\uninstall-cleanup.ps1" 0 un_keepDataLegacy
    nsExec::ExecToLog 'powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$INSTDIR\scripts\uninstall-cleanup.ps1" -Root "$INSTDIR" -Mode keep-data'
    Pop $0
    ${If} $0 != 0
      DetailPrint "Cleanup helper returned exit code $0, falling back to legacy cleanup."
      Goto un_keepDataLegacy
    ${EndIf}
    Goto un_keepDataDone

un_keepDataLegacy:
  CreateDirectory "$INSTDIR\.uninstall-preserve"
  IfFileExists "$INSTDIR\server\data\*.*" 0 un_noServerData
    Rename "$INSTDIR\server\data" "$INSTDIR\.uninstall-preserve\server-data"
un_noServerData:

  RMDir /r "$INSTDIR\desktop"
  RMDir /r "$INSTDIR\docs"
  RMDir /r "$INSTDIR\installer"
  RMDir /r "$INSTDIR\node_modules"
  RMDir /r "$INSTDIR\scripts"
  RMDir /r "$INSTDIR\server"
  RMDir /r "$INSTDIR\web"

  IfFileExists "$INSTDIR\.uninstall-preserve\server-data\*.*" 0 un_noRestoreServerData
    CreateDirectory "$INSTDIR\server"
    Rename "$INSTDIR\.uninstall-preserve\server-data" "$INSTDIR\server\data"
un_noRestoreServerData:
  RMDir /r "$INSTDIR\.uninstall-preserve"

  Delete "$INSTDIR\*.bat"
  Delete "$INSTDIR\*.cmd"
  Delete "$INSTDIR\*.ps1"
  Delete "$INSTDIR\*.vbs"
  Delete "$INSTDIR\*.md"
  Delete "$INSTDIR\*.json"
  Delete "$INSTDIR\.env.example"
  Delete "$INSTDIR\.gitignore"
  Delete "$INSTDIR\AgentHub-release.zip"
  Delete "$INSTDIR\AgentHub-release.release-check.json"

un_keepDataDone:
  Delete "$INSTDIR\Uninstall.exe"

  RMDir "$INSTDIR"
  IfSilent un_done
  MessageBox MB_ICONINFORMATION "Xgent Hub 程序已删除，数据保留在：$\r$\n$INSTDIR"
  Goto un_done

un_fullCleanup:
  DetailPrint "Removing all Xgent Hub files and local data..."
  SetOutPath "$TEMP"
  IfFileExists "$INSTDIR\scripts\uninstall-cleanup.ps1" 0 un_fullCleanupLegacy
    nsExec::ExecToLog 'powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$INSTDIR\scripts\uninstall-cleanup.ps1" -Root "$INSTDIR" -Mode full'
    Pop $0
    ${If} $0 != 0
      DetailPrint "Cleanup helper returned exit code $0, falling back to legacy full cleanup."
      Goto un_fullCleanupLegacy
    ${EndIf}
    Goto un_fullCleanupDone

un_fullCleanupLegacy:
  Delete "$INSTDIR\Uninstall.exe"
  RMDir /r "$INSTDIR"
  Goto un_fullCleanupMessage

un_fullCleanupDone:
  Delete "$INSTDIR\Uninstall.exe"
  RMDir "$INSTDIR"

un_fullCleanupMessage:
  IfSilent un_done
  MessageBox MB_ICONINFORMATION "Xgent Hub 已卸载，安装目录已删除。"

un_done:
SectionEnd
