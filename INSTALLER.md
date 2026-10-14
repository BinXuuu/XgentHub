# Xgent Hub installer route

Xgent Hub V1.0 uses a zip-first installer bundle.

This is intentional. Xgent Hub depends on local CLI login state, local API keys, local model services, and user-selected workspace paths. A classic EXE/MSI installer can hide too much of that setup too early. The zip-first route keeps the install process visible and easy to audit while the adapter layer is still growing.

## Recommended install flow

1. Install Node.js 22.5 or newer.
2. Extract the AgentHub installer bundle.
3. Extract the included `XgentHub-*-release.zip` to the final install folder.
4. Run `install.bat`.
5. Optional: run `manage-shortcuts.bat install`.
6. Run `start-app.bat` to open the desktop app shell, or run `start-prod.bat` for browser-only mode.
7. Open `http://127.0.0.1:4180`, or the port configured by `.env PORT`, when using browser-only mode.
8. Open the configuration center, run machine discovery, connect local agents, then use the finish step to copy LAN/mobile URLs.

The machine discovery step writes only non-sensitive local values such as CLI paths and local service URLs. API keys, model gateway credentials, and personal tokens still need to be entered manually or restored from a trusted private config bundle.

## Files users should run

- `install.bat`: first-time setup, dependency install, production build, and doctor check.
- `start-app.bat`: open the Xgent Hub desktop app shell and start the local service when needed.
- `start-prod.bat`: start Xgent Hub and Ollama in production mode.
- `restart-prod.bat`: restart production mode.
- `status-prod.bat`: check production mode status.
- `stop.bat`: stop AgentHub.
- `doctor.bat`: inspect local dependencies and common agent setup issues.
- `test-install-package.bat`: smoke-test a release or installer zip by extracting it into a temporary folder and checking required files/exclusions.
- `test-nsis-installer.bat`: smoke-test the NSIS installer by silently installing to a temporary folder, starting/stopping the service on a test port, silently uninstalling, and checking that local data is retained.
- `manage-shortcuts.bat install`: create desktop and Start Menu shortcuts.
- `manage-shortcuts.bat remove`: remove the shortcuts created by Xgent Hub.
- `installer-entry.bat`: stable wrapper entry for future NSIS/MSI installers.

## Stable installer entry commands

- `installer-entry.bat doctor`
- `installer-entry.bat install`
- `installer-entry.bat install-shortcuts`
- `installer-entry.bat install-startup`
- `installer-entry.bat start-app`
- `installer-entry.bat start-prod`
- `installer-entry.bat start-prod-config`
- `installer-entry.bat restart-prod`
- `installer-entry.bat status-prod`
- `installer-entry.bat open-logs`
- `installer-entry.bat open-backups`
- `installer-entry.bat open-root`

## Packaging options evaluated

- Zip-first: selected for V1.0 because it is transparent, easy to verify, and works with local CLI login flows.
- NSIS: selected as the first GUI installer prototype in V1.3 because it is small, scriptable, and can call the fixed `installer-entry.bat` actions.
- WiX/MSI: good future option for enterprise deployment, but heavier to maintain.
- Electron shell: selected as the V2.6 app-style entry. It is still backed by the same local web service, but desktop shortcuts can now open a real app window with tray controls.
- Squirrel/Electron bundling: future option for a more standalone app that embeds runtime pieces and improves auto-update, but it is heavier than the current NSIS + local install route.

## Release hygiene

Use `build-installer.bat` to create the installer bundle. It runs the release check first, includes the verified release zip, writes SHA256 hashes, and keeps private files out of the package.

Use `build-nsis-installer.bat` to create the NSIS GUI installer prototype. It runs the same release check first. If `makensis.exe` is not installed, it leaves a build report and manual compile command in `backups/`.

Before handing a bundle to another machine, run:

```powershell
test-install-package.bat -InstallerZip D:\Agent\AgentHub\backups\XgentHub-installer-xxxx.zip
```

By default this is a structural smoke test: it extracts the package to `backups\.install-smoke-*`, verifies required files, verifies `SHA256SUMS.txt`, and checks that private files such as `.env`, `node_modules`, logs, backups, and SQLite data are not included. Add `-RunInstall` when you want to run the full `install.bat` inside the smoke-test folder. Add `-RunService` together with `-RunInstall` to start the temporary install on a test port, check health/status/doctor, and stop it again.

After building the NSIS prototype, run:

```powershell
test-nsis-installer.bat -InstallerExe D:\Agent\AgentHub\backups\XgentHub-setup-nsis-xxxx.exe
```

The NSIS smoke test uses `backups\.nsis-smoke-*`, changes the temporary install to a test port, and validates silent uninstall retention.

For open-source release hygiene, see `docs/release-checklist.md`.
