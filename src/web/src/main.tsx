import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { Gate } from "./screens/Gate";
import { ToastHost } from "./ui";
import "./style.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ToastHost>
      <Gate>
        <App />
      </Gate>
    </ToastHost>
  </StrictMode>,
);
