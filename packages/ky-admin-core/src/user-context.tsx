import { createContext, useContext, type PropsWithChildren } from "react";
import type { CurrentUser } from "./index";

const CurrentUserContext = createContext<CurrentUser | null>(null);

export function CurrentUserContextProvider({
  children,
  user
}: PropsWithChildren<{ user: CurrentUser | null }>) {
  return <CurrentUserContext.Provider value={user}>{children}</CurrentUserContext.Provider>;
}

export function useCurrentUser() {
  return useContext(CurrentUserContext);
}
