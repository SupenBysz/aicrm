import { createContext, useContext, type PropsWithChildren } from "react";
import type { PluginInventoryPort } from "./plugin-inventory";
const PluginInventoryContext = createContext<PluginInventoryPort | null>(null);
export function PluginInventoryProvider({ port, children }: PropsWithChildren<{ port: PluginInventoryPort }>) { return <PluginInventoryContext.Provider value={port}>{children}</PluginInventoryContext.Provider>; }
export function usePluginInventoryPort(): PluginInventoryPort { const port=useContext(PluginInventoryContext); if(!port) throw new Error("usePluginInventoryPort must be used within PluginInventoryProvider"); return port; }
