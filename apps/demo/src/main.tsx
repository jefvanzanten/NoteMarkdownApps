import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { TabProvider } from "./context/TabContext.js";
import { App } from "./App.js";

const root = document.getElementById("root");
if (!root) throw new Error("Root element not found");

createRoot(root).render(
  <StrictMode>
    <TabProvider>
      <App />
    </TabProvider>
  </StrictMode>,
);
