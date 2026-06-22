import { createContext, useContext, type PropsWithChildren } from "react";
import type { RequestClient } from "./index";

const RequestClientContext = createContext<RequestClient | null>(null);

export function RequestClientProvider({
  children,
  client
}: PropsWithChildren<{ client: RequestClient }>) {
  return <RequestClientContext.Provider value={client}>{children}</RequestClientContext.Provider>;
}

export function useRequestClient(): RequestClient {
  const client = useContext(RequestClientContext);
  if (!client) {
    throw new Error("useRequestClient must be used within a RequestClientProvider");
  }
  return client;
}
