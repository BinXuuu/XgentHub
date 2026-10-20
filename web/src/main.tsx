import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { DialogHost } from "./components/DialogHost";
import "./styles/global.css";
import { applyTheme, readStoredTheme } from "./utils/theme";

applyTheme(readStoredTheme("light"));

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
    <DialogHost />
  </React.StrictMode>
);
