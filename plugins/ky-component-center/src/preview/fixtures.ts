import type { RequestClient } from "@ky/admin-core";
/** No network fallback, auth propagation, shared mutable state, or real identifiers. */
export function createDemoClient(): RequestClient {
 return {request: async <T>(path: string, options = {}) => {
  const request = options as {method?:string;body?:unknown};
  if(path === "/demo/options" && (!request.method || request.method === "GET") && request.body === undefined)
   return [{value:"one",label:"虚构选项"}] as T;
  throw new Error("预览拒绝未登记请求");
 }};
}
