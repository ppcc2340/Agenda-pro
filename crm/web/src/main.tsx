import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./styles.css";
import "./components/pro.css";
import { MfaGate } from "./components/MfaGate";
import { applyTheme } from "./lib/prefs";
applyTheme();
window.matchMedia?.("(prefers-color-scheme: dark)").addEventListener?.("change", () => applyTheme());

ReactDOM.createRoot(document.getElementById("root")!).render(<React.StrictMode><App /><MfaGate /></React.StrictMode>);
