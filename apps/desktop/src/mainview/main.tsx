import React from "react";
import ReactDOM from "react-dom/client";
import { Electroview } from "electrobun/view";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { MonitorRPC } from "../stubs/types";
import { MonitorPage } from "./app/MonitorPage";
import "../styles/rawblock.css";
import "./app/index.css";

const rpc = Electroview.defineRPC<MonitorRPC>({
  handlers: {
    requests: {},
    messages: {},
  },
});

new Electroview({ rpc });
(window as any).__monitorRpc = rpc;

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: false,
      staleTime: 10_000,
    },
  },
});

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <div className="h-full w-full bg-white text-black flex justify-center items-center">
        <MonitorPage />
      </div>
    </QueryClientProvider>
  </React.StrictMode>,
);
