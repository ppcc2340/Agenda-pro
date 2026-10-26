import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./styles.css";
import "./components/pro.css";
import { MfaGate } from "./components/MfaGate";

ReactDOM.createRoot(document.getElementById("root")!).render(<React.StrictMode><App /><MfaGate /></React.StrictMode>);
