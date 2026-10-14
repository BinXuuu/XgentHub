# Xgent Hub Desktop Shell

This Electron shell opens the local Xgent Hub web console in a desktop window and starts the production service when needed.

- `npm run desktop:start` starts the shell during development.
- `npm run desktop:smoke` verifies that the shell can start or find the local service without opening a window.
- `start-app.bat` and `start-app.vbs` are the user-facing launchers used by shortcuts and installers.

The shell does not replace the service scripts. `start-prod.bat`, `status-prod.bat`, and `stop.bat` remain available for browser-only and maintenance workflows.
