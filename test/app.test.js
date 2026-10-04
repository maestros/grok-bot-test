import assert from "node:assert/strict";
import { request } from "node:http";
import test from "node:test";
import { createApp } from "../src/server.js";
import { SESSION_COOKIE, signSession } from "../src/security/session.js";

const secret = "test-secret-that-is-at-least-32-characters";

function baseConfig(overrides = {}) {
  return {
    port: 0,
    nodeEnv: "test",
    sessionSecret: secret,
    linkedin: {
      clientId: "",
      clientSecret: "",
      callbackUrl: "",
    },
    xai: {
      apiKey: "test-key",
      model: "grok-4.7",
      baseUrl: "https://api.x.ai/v1",
    },
    braveSearchApiKey: "",
    ...overrides,
  };
}

test("LinkedIn return on the redirect_uri path exchanges the code", async (t) => {
  const callbacks = [
    "https://colleagues.onrender.com/auth/linkedin",
    "http://localhost:3000/auth/linkedin/callback",
  ];
  for (const callbackUrl of callbacks) {
    const exchanged = [];
    const app = createApp({
      config: baseConfig({
        linkedin: {
          clientId: "client-id",
          clientSecret: "client-secret",
          callbackUrl,
        },
      }),
      linkedin: {
        async exchangeCode(args) {
          exchanged.push(args);
          return { id_token: "id-token", access_token: "access-token" };
        },
        async verifyIdToken({ nonce }) {
          assert.equal(typeof nonce, "string");
          assert.ok(nonce.length > 10);
          return { sub: "person-1", name: "Pat Example" };
        },
        async fetchUserInfo() {
          return { sub: "person-1", name: "Pat Example" };
        },
      },
    });
    const server = app.listen(0);
    t.after(() => new Promise((resolve) => server.close(resolve)));
    const port = server.address().port;

    const start = await send(port, "GET", "/auth/linkedin");
    assert.equal(start.status, 302);
    const authorization = new URL(start.headers.location);
    assert.equal(authorization.searchParams.get("redirect_uri"), callbackUrl);
    const returnPath = new URL(callbackUrl).pathname;
    const state = authorization.searchParams.get("state");
    const oauthCookie = cookiePair(start.headers["set-cookie"], "colleagues_oauth");

    const restarted = await send(port, "GET", `${returnPath}?code=auth-code&state=${encodeURIComponent(state)}`);
    assert.equal(restarted.status, 302);
    assert.equal(restarted.headers.location, "/?error=linkedin_state");
    assert.equal(exchanged.length, 0);

    const returned = await send(
      port,
      "GET",
      `${returnPath}?code=auth-code&state=${encodeURIComponent(state)}`,
      { headers: { cookie: oauthCookie } },
    );
    assert.equal(returned.status, 302);
    assert.equal(returned.headers.location, "/");
    assert.equal(String(returned.headers.location).includes("linkedin.com"), false);
    assert.equal(exchanged.length, 1);
    assert.equal(exchanged[0].code, "auth-code");
    assert.equal(exchanged[0].callbackUrl, callbackUrl);

    const sessionCookie = cookiePair(returned.headers["set-cookie"], "colleagues_session");
    const session = await send(port, "GET", "/api/session", { headers: { cookie: sessionCookie } });
    const body = JSON.parse(session.body);
    assert.equal(body.authenticated, true);
    assert.equal(body.user.name, "Pat Example");
  }
});

test("health, sign-in, and a signed-in lookup", async (t) => {
  const app = createApp({
    config: baseConfig({
      linkedin: {
        clientId: "client-id",
        clientSecret: "client-secret",
        callbackUrl: "http://localhost:3000/auth/linkedin/callback",
      },
    }),
    runResearchImpl: async ({ rawQuery, onStatus }) => {
      onStatus("verifying");
      return {
        query: { raw: rawQuery, kind: "name", name: rawQuery },
        subject: {
          name: rawQuery,
          roles: [{
            company: "Example",
            title: "Researcher",
            team: null,
            start: "2018",
            end: null,
            current: true,
            currentBasis: "source_text",
            sourceUrl: "https://example.com/bio",
            evidence: `${rawQuery} is a Researcher at Example since 2018.`,
          }],
        },
        disambiguation: [],
        currentColleagues: [],
        pastColleagues: [],
        unestablished: [],
        sources: [{ url: "https://example.com/bio", title: "Bio", ok: true, error: null }],
        omitted: {},
        notes: [],
        search: [],
      };
    },
  });
  const server = app.listen(0);
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const port = server.address().port;

  const health = await send(port, "GET", "/health");
  assert.equal(health.status, 200);
  const healthBody = JSON.parse(health.body);
  assert.equal(healthBody.ok, true);
  assert.equal(healthBody.xaiConfigured, true);
  assert.equal(JSON.stringify(healthBody).includes("test-key"), false);
  assert.equal(JSON.stringify(healthBody).includes("client-secret"), false);

  const home = await send(port, "GET", "/");
  assert.equal(home.status, 200);
  assert.match(home.body, /Sign in with LinkedIn/);

  const unconfigured = createApp({ config: baseConfig() });
  const unconfiguredServer = unconfigured.listen(0);
  t.after(() => new Promise((resolve) => unconfiguredServer.close(resolve)));
  const missing = await send(unconfiguredServer.address().port, "GET", "/auth/linkedin");
  assert.equal(missing.status, 503);
  assert.match(missing.body, /not configured/);

  const start = await send(port, "GET", "/auth/linkedin");
  assert.equal(start.status, 302);
  const location = new URL(start.headers.location);
  assert.equal(location.origin, "https://www.linkedin.com");
  assert.equal(location.pathname, "/oauth/v2/authorization");
  assert.equal(location.searchParams.get("scope"), "openid profile email");
  assert.equal(location.searchParams.get("redirect_uri"), "http://localhost:3000/auth/linkedin/callback");
  const cookies = [].concat(start.headers["set-cookie"] || []);
  assert.ok(cookies.some((cookie) => cookie.startsWith("colleagues_oauth=")));

  const anonymous = await send(port, "POST", "/api/research", { body: { query: "Ada Lovelace" } });
  assert.equal(anonymous.status, 401);

  const token = await signSession({ sub: "member-1", name: "Ada Lovelace", csrf: "csrf-token" }, secret);
  const cookie = `${SESSION_COOKIE}=${encodeURIComponent(token)}`;
  const badToken = await send(port, "POST", "/api/research", {
    headers: { cookie, "x-csrf-token": "nope" },
    body: { query: "Ada Lovelace" },
  });
  assert.equal(badToken.status, 403);

  const created = await send(port, "POST", "/api/research", {
    headers: { cookie, "x-csrf-token": "csrf-token" },
    body: { query: "Ada Lovelace" },
  });
  assert.equal(created.status, 202);
  const jobId = JSON.parse(created.body).id;
  let job;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const polled = await send(port, "GET", `/api/research/${jobId}`, { headers: { cookie } });
    job = JSON.parse(polled.body);
    if (job.status === "done") break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(job.status, "done");
  assert.equal(job.result.subject.name, "Ada Lovelace");
  assert.equal(job.result.subject.roles[0].sourceUrl, "https://example.com/bio");
});

function cookiePair(setCookie, name) {
  const cookies = [].concat(setCookie || []);
  const match = cookies.find((cookie) => cookie.startsWith(`${name}=`));
  assert.ok(match, `missing ${name} cookie`);
  return match.split(";")[0];
}

function send(port, method, path, { headers = {}, body } = {}) {
  const payload = body ? JSON.stringify(body) : null;
  return new Promise((resolve, reject) => {
    const req = request({
      port,
      method,
      path,
      headers: {
        Accept: "application/json",
        ...(payload ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } : {}),
        ...headers,
      },
    }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      }));
    });
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}
