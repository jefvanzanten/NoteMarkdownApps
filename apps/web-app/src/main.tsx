import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { registerPwa } from "./pwa";
import "./styles/tokens.css";
import "./styles/global.css";

const root = document.getElementById("root");
if (!root) throw new Error("The NoteMarkdown root element is missing.");

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

void registerPwa();
