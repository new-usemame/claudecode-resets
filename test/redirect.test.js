import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PORT = 3199;
let server;

async function get(host, path = "/") {
  // node's fetch refuses to set Host, so talk to the socket directly.
  const { request } = await import("node:http");
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port: PORT, path, headers: { host } }, (res) => {
      res.resume();
      resolve({ status: res.statusCode, location: res.headers.location });
    });
    req.on("error", reject);
    req.end();
  });
}

test("host-header redirects", async (t) => {
  server = spawn("node", ["src/server.js"], {
    env: { ...process.env, PORT: String(PORT), FETCHER: "off",
           SITE_ORIGIN: "https://claude-reset.com",
           DATA_DIR: mkdtempSync(join(tmpdir(), "ccr-redir-")) },
    stdio: "ignore",
  });
  await new Promise((r) => setTimeout(r, 2500));
  t.after(() => server.kill());

  await t.test("a www host we serve redirects to its own apex, keeping the path", async () => {
    const a = await get("www.claude-reset.com", "/api/v1/status");
    assert.equal(a.status, 301);
    assert.equal(a.location, "https://claude-reset.com/api/v1/status");

    // and NOT to the canonical origin — someone who typed the other domain stays there
    const b = await get("www.claudecode-resets.com", "/api/v1/status");
    assert.equal(b.status, 301);
    assert.equal(b.location, "https://claudecode-resets.com/api/v1/status");
  });

  await t.test("a www host we do NOT serve is never a redirect target", async () => {
    // The Host header is attacker-controlled. Echoing it into Location would let
    // anyone bounce visitors off our domain to theirs.
    for (const evil of ["www.evil.com", "www.attacker.example", "www.google.com"]) {
      const r = await get(evil);
      assert.equal(r.status, 404, `${evil} must not redirect`);
      assert.equal(r.location, undefined, `${evil} must not set Location`);
    }
  });

  await t.test("the ACME challenge path is never redirected", async () => {
    const r = await get("www.claude-reset.com", "/.well-known/acme-challenge/probe");
    assert.notEqual(r.status, 301, "redirecting this stops a certificate ever issuing");
  });
});
