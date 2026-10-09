import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Tooltip } from "radix-ui";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { OverlayProvider } from "./ui/overlays";
import "./styles/index.css";

const client = new QueryClient({
  defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={client}>
      <Tooltip.Provider delayDuration={250}>
        <OverlayProvider>
          <App />
        </OverlayProvider>
      </Tooltip.Provider>
    </QueryClientProvider>
  </StrictMode>,
);
