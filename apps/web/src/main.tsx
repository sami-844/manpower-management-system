import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { HashRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import "@fontsource/atkinson-hyperlegible-next/400.css";
import "@fontsource/atkinson-hyperlegible-next/700.css";
import "./styles.css";
import { Layout } from "./components/Layout";
import { Today } from "./pages/Today";
import { Workers } from "./pages/Workers";
import { WorkerFile } from "./pages/WorkerFile";
import { Renewals } from "./pages/Renewals";

const queryClient = new QueryClient({ defaultOptions: { queries: { staleTime: 15_000, refetchOnWindowFocus: true } } });

// HashRouter so the same build works on a web server and inside the Tauri desktop app.
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <HashRouter>
        <Routes>
          <Route element={<Layout />}>
            <Route index element={<Today />} />
            <Route path="workers" element={<Workers />} />
            <Route path="workers/:id" element={<WorkerFile />} />
            <Route path="renewals" element={<Renewals />} />
            <Route path="*" element={<p className="empty">This page doesn't exist.</p>} />
          </Route>
        </Routes>
      </HashRouter>
    </QueryClientProvider>
  </StrictMode>,
);
