import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { ErrorBoundary } from "./design-system/ErrorBoundary.tsx";
import { ToastProvider } from "./design-system/Toast.tsx";
import { LocaleProvider } from "./i18n/locale-context.tsx";
import "./index.css";

const container = document.getElementById("root");
if (container === null) throw new Error("#root is missing from index.html.");

createRoot(container).render(
  <StrictMode>
    <LocaleProvider>
      <ToastProvider>
        {/* A render error must never be a blank page again — see ErrorBoundary. */}
        <ErrorBoundary where="Application">
          <App />
        </ErrorBoundary>
      </ToastProvider>
    </LocaleProvider>
  </StrictMode>,
);
