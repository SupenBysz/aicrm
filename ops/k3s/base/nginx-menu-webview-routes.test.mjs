import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const config = await readFile(new URL("./nginx.conf", import.meta.url), "utf8");

function locationBlock(location) {
  const escaped = location.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = config.match(new RegExp(`location ${escaped} \\{([\\s\\S]*?)\\n  \\}`, "m"));
  assert.ok(match, `missing nginx location ${location}`);
  return match[1];
}

test("menu directory and configuration API routes preserve workspace/auth headers to membership", () => {
  for (const location of ["/api/v1/menu-directory/", "/api/v1/menu-webviews/"]) {
    const block = locationBlock(location);
    assert.match(block, /proxy_pass http:\/\/membership:18083;/);
    assert.match(block, /proxy_set_header Authorization \$http_authorization;/);
    assert.match(block, /proxy_set_header X-KY-Workspace-Id \$http_x_ky_workspace_id;/);
    assert.match(block, /proxy_set_header X-KY-Workspace-Type \$http_x_ky_workspace_type;/);
    assert.match(block, /proxy_set_header X-KY-Request-Id \$http_x_ky_request_id;/);
  }
});

test("menu runtime resolve is routed to matrix before the generic membership menu-webviews route", () => {
  const runtimeRoute = "~ ^/api/v1/menu-webviews/[^/]+/[^/]+/runtime-resolve$";
  const runtimeBlock = locationBlock(runtimeRoute);
  const genericBlock = locationBlock("/api/v1/menu-webviews/");
  assert.match(runtimeBlock, /proxy_pass http:\/\/matrix:18085;/);
  assert.match(runtimeBlock, /proxy_set_header Authorization \$http_authorization;/);
  assert.match(runtimeBlock, /proxy_set_header X-KY-Workspace-Id \$http_x_ky_workspace_id;/);
  assert.match(runtimeBlock, /proxy_set_header X-KY-Workspace-Type \$http_x_ky_workspace_type;/);
  assert.match(runtimeBlock, /proxy_set_header X-KY-Request-Id \$http_x_ky_request_id;/);
  assert.ok(config.indexOf(runtimeRoute) < config.indexOf("location /api/v1/menu-webviews/"));
  assert.match(genericBlock, /proxy_pass http:\/\/membership:18083;/);
});
