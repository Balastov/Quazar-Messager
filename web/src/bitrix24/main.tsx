import React from "react";
import { createRoot } from "react-dom/client";
import BitrixPage from "./BitrixPage";
import "./style.css";

// Isolated entry: no Quazar auth, service worker, persisted session or push setup.
createRoot(document.getElementById("root")!).render(<React.StrictMode><BitrixPage /></React.StrictMode>);
