import assert from "node:assert/strict";
import test from "node:test";
import { assertPublicHttpUrl, hostnameBlocked, isPrivateAddress } from "../src/security/ssrf.js";
import { signSession, verifyPayload } from "../src/security/session.js";

const secret = "test-secret-that-is-at-least-32-characters";

test("blocks private addresses and LinkedIn hosts", async () => {
  assert.equal(isPrivateAddress("10.1.2.3"), true);
  assert.equal(isPrivateAddress("127.0.0.1"), true);
  assert.equal(isPrivateAddress("169.254.169.254"), true);
  assert.equal(isPrivateAddress("8.8.8.8"), false);
  assert.equal(isPrivateAddress("::1"), true);
  assert.equal(hostnameBlocked("www.linkedin.com"), true);
  assert.equal(hostnameBlocked("lnkd.in"), true);
  await assert.rejects(() => assertPublicHttpUrl("https://www.linkedin.com/in/someone"), /not a public research source/);
  await assert.rejects(() => assertPublicHttpUrl("http://127.0.0.1/latest/meta-data"), /IP addresses/);
  await assert.rejects(() => assertPublicHttpUrl("https://example.com:22/path"), /ports 80 and 443/);
  await assert.rejects(() => assertPublicHttpUrl("http://localhost/admin"), /not a public research source/);
});

test("session cookies are signed and reject tampering", async () => {
  const token = await signSession({ sub: "abc", name: "Ada Lovelace", csrf: "csrf-value" }, secret);
  const payload = await verifyPayload(token, secret);
  assert.equal(payload.sub, "abc");
  assert.equal(payload.name, "Ada Lovelace");
  await assert.rejects(() => verifyPayload(token, `${secret}-other-secret-value`));
  await assert.rejects(() => signSession({ sub: "abc", name: "Ada", csrf: "x" }, "too-short"));
});
