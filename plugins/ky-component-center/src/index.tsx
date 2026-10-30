import type { AdminPlugin } from "@ky/admin-core";
import { routes } from "./routes";
export const componentCenterPlugin: AdminPlugin = { name: "ky-component-center", routes };
export default componentCenterPlugin;
