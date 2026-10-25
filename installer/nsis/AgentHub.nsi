!include "MUI2.nsh"
!include "LogicLib.nsh"

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

Name "Xgent Hub"
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

!insertmacro MUI_LANGUAGE "English"

Section "Xgent Hub core files" SEC_CORE
  SectionIn RO
  SetOutPath "$INSTDIR"
  File /oname=AgentHub-release.zip "${RELEASE_ZIP}"
  File /oname=AgentHub-release.release-check.json "${RELEASE_REPORT}"

  DetailPrint "Extracting Xgent Hub release package..."
  nsExec::ExecToLog "powershell.exe -NoProfile -ExecutionPolicy Bypass -Command $\"Expand-Archive -LiteralPath '$INSTDIR\AgentHub-release.zip' -DestinationPath '$INSTDIR' -Force$\""
  Pop $0
  ${If} $0 != 0
    IfSilent coreExtractAbort
    MessageBox MB_ICONSTOP "Failed to extract Xgent Hub release package. Exit code: $0"
coreExtractAbort:
    Abort
  ${EndIf}

  DetailPrint "Running Xgent Hub install.bat..."
  nsExec::ExecToLog 'cmd.exe /C ""$INSTDIR\install.bat""'
  Pop $0
  ${If} $0 != 0
    IfSilent coreInstallAbort
    MessageBox MB_ICONEXCLAMATION "install.bat returned exit code $0. You can run xgent.bat doctor from the install folder for details."
    Goto coreInstallWarningDone
coreInstallAbort:
    Abort
coreInstallWarningDone:
  ${EndIf}

  WriteUninstaller "$INSTDIR\Uninstall.exe"
SectionEnd

Section "Create desktop and Start Menu shortcuts" SEC_SHORTCUTS
  DetailPrint "Creating Xgent Hub shortcuts..."
  ExecWait 'powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$INSTDIR\scripts\installer-entry.ps1" install-shortcuts'
SectionEnd

Section /o "Start Xgent Hub when Windows user logs in" SEC_STARTUP
  DetailPrint "Installing Xgent Hub startup task..."
  ExecWait 'powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$INSTDIR\scripts\installer-entry.ps1" install-startup'
SectionEnd

Section /o "Start Xgent Hub desktop app after install" SEC_START
  DetailPrint "Starting Xgent Hub desktop app..."
  Exec 'powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "$INSTDIR\scripts\installer-entry.ps1" start-app'
SectionEnd

Section "Uninstall"
  DetailPrint "Stopping Xgent Hub..."
  IfFileExists "$INSTDIR\scripts\agenthub.ps1" 0 un_skipStop
    ExecWait 'powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$INSTDIR\scripts\agenthub.ps1" stop'
un_skipStop:

  DetailPrint "Removing Xgent Hub startup task and shortcuts..."
  IfFileExists "$INSTDIR\scripts\installer-entry.ps1" 0 un_skipInstallerEntry
    ExecWait 'powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$INSTDIR\scripts\installer-entry.ps1" remove-startup'
    ExecWait 'powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$INSTDIR\scripts\installer-entry.ps1" remove-shortcuts'
un_skipInstallerEntry:

  IfSilent un_keepData
  MessageBox MB_YESNO|MB_ICONQUESTION "Do you also want to remove local configuration, task data, logs, and backups?$\r$\n$\r$\nChoose Yes for a full cleanup.$\r$\nChoose No to remove only program files and keep local data in:$\r$\n$INSTDIR" IDYES un_fullCleanup IDNO un_keepData

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
  MessageBox MB_ICONINFORMATION "Xgent Hub program files were removed. Local data was kept in:$\r$\n$INSTDIR"
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
  MessageBox MB_ICONINFORMATION "Xgent Hub was uninstalled. The install folder was removed."

un_done:
SectionEnd
