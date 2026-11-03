import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource-variable/google-sans";
import "@fontsource-variable/inter";
import "./styles.css";
import "./ui.css";
import App from "./App";
import { Gate } from "./components/Auth";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Gate>
      <App />
    </Gate>
  </StrictMode>,
);
