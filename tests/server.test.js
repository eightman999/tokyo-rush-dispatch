import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createApp } from "../server.mjs";

test("production server serves build and assets, rejects unsafe paths and methods", async (t) => {
  const server = createApp();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const response = await fetch(base);
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /text\/html/);
  assert.match(
    response.headers.get("content-security-policy"),
    /script-src 'self'/,
  );
  const html = await response.text();
  assert.match(html, /首都圏輸送指令室/);
  const script = html.match(/src="([^"]+\.js)"/)[1];
  const asset = await fetch(base + script);
  assert.equal(asset.status, 200);
  assert.match(asset.headers.get("content-type"), /javascript/);
  assert.match(asset.headers.get("cache-control"), /immutable/);
  const head = await fetch(base, { method: "HEAD" });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), "");
  assert.equal(await (await fetch(base + "/health")).text(), "ok");
  for (const path of [
    "/.env",
    "/.gcloud/application_default_credentials.json",
    "/src/engine.js",
    "/package.json",
    "/server.mjs",
    "/%2e%2e%2fpackage.json",
    "/missing.js",
  ])
    assert.equal((await fetch(base + path)).status, 404, path);
  assert.equal((await fetch(base + "/%FF")).status, 400);
  assert.equal((await fetch(base, { method: "POST" })).status, 405);
});
