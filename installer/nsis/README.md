# AgentHub NSIS prototype

This folder contains the first Windows GUI installer prototype for AgentHub.

The NSIS installer embeds a release zip that has already passed `release-check`, extracts it into a user-writable install directory, runs `install.bat`, and then uses `scripts/installer-entry.ps1` for optional actions.

Default behavior:

- user-level install, no administrator elevation
- default path: `%LOCALAPPDATA%\Programs\AgentHub`
- required core installation
- optional shortcuts
- optional startup task
- optional start after install, opening the configuration center directly on the machine discovery step

Build with:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\build-nsis-installer.ps1
```

If `makensis.exe` is not installed, the build script still creates the checked release zip, a build report, and a manual compile command under `backups/`.
