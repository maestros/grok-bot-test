import { randomBytes, timingSafeEqual } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { buildAuthorizationUrl, exchangeCode, fetchUserInfo, randomToken, verifyIdToken } from "./auth/linkedin.js";
import { linkedinConfigured, loadConfig, xaiConfigured } from "./config.js";
import { ResearchError } from "./errors.js";
import { parseLookup } from "./research/input.js";
import { createResearchDeps, runResearch } from "./research/pipeline.js";
import {
  OAUTH_COOKIE,
  SESSION_COOKIE,
  cookieHeader,
  readCookies,
  readSession,
  requestIsSecure,
  signOauth,
  signSession,
  verifyPayload,
} from "./security/session.js";

const SESSION_SECONDS = 60 * 60 * 24 * 7;
const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "../public");

export function createApp({ config = loadConfig(), runResearchImpl = null, fetchImpl = fetch } = {}) {
  const app = express();
  const jobs = new Map();
  const rateLimits = new Map();
  const research = runResearchImpl || ((args) => runResearch({
    ...args,
    deps: createResearchDeps({ config, fetchImpl }),
  }));

  app.disable("x-powered-by");
  app.set("trust proxy", 1);
  app.use(express.json({ limit: "32kb" }));
  app.use((req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; style-src 'self'; img-src 'self' https:; form-action 'self' https://www.linkedin.com; frame-ancestors 'none'; base-uri 'self'",
    );
    next();
  });

  app.get("/health", (_req, res) => {
    res.json({
      ok: true,
      linkedinConfigured: linkedinConfigured(config),
      xaiConfigured: xaiConfigured(config),
      search: {
        duckduckgo: true,
        wikipedia: true,
        brave: Boolean(config.braveSearchApiKey),
      },
    });
  });

  app.get("/api/session", async (req, res) => {
    const session = await readSession(req, config.sessionSecret);
    res.setHeader("Cache-Control", "no-store");
    if (!session) {
      res.json({ authenticated: false, researchReady: xaiConfigured(config) });
      return;
    }
    res.json({
      authenticated: true,
      user: { name: session.name },
      csrfToken: session.csrf,
      researchReady: xaiConfigured(config),
    });
  });

  app.get("/auth/linkedin", async (req, res) => {
    if (!linkedinConfigured(config)) {
      res.status(503).type("html").send(messagePage(
        "LinkedIn sign-in is not configured",
        "Set LINKEDIN_CLIENT_ID, LINKEDIN_CLIENT_SECRET, and LINKEDIN_CALLBACK_URL on the server, then reload.",
      ));
      return;
    }
    const state = randomToken();
    const nonce = randomToken();
    const token = await signOauth({ state, nonce }, config.sessionSecret);
    res.setHeader("Set-Cookie", cookieHeader(OAUTH_COOKIE, token, {
      maxAge: 60 * 10,
      secure: requestIsSecure(req),
    }));
    res.redirect(buildAuthorizationUrl({
      clientId: config.linkedin.clientId,
      callbackUrl: config.linkedin.callbackUrl,
      state,
      nonce,
    }));
  });

  app.get("/auth/linkedin/callback", async (req, res) => {
    const secure = requestIsSecure(req);
    const fail = (code) => {
      res.setHeader("Set-Cookie", cookieHeader(OAUTH_COOKIE, "", { maxAge: 0, secure }));
      res.redirect(`/?error=${code}`);
    };
    if (!linkedinConfigured(config)) return fail("linkedin_config");
    if (req.query.error) return fail("linkedin_denied");
    const code = typeof req.query.code === "string" ? req.query.code : "";
    const state = typeof req.query.state === "string" ? req.query.state : "";
    if (!code || !state) return fail("linkedin_state");
    const oauthToken = readCookies(req.headers.cookie)[OAUTH_COOKIE];
    let oauth;
    try {
      oauth = await verifyPayload(oauthToken, config.sessionSecret);
    } catch {
      return fail("linkedin_state");
    }
    if (!oauth?.state || !sameToken(oauth.state, state) || !oauth.nonce) return fail("linkedin_state");

    try {
      const tokens = await exchangeCode({
        code,
        clientId: config.linkedin.clientId,
        clientSecret: config.linkedin.clientSecret,
        callbackUrl: config.linkedin.callbackUrl,
        fetchImpl,
      });
      if (!tokens.id_token) return fail("linkedin_token");
      const identity = await verifyIdToken({
        idToken: tokens.id_token,
        clientId: config.linkedin.clientId,
        nonce: oauth.nonce,
      });
      if (tokens.access_token) {
        try {
          const userInfo = await fetchUserInfo({ accessToken: tokens.access_token, fetchImpl });
          if (userInfo.sub !== identity.sub) return fail("linkedin_token");
          if (userInfo.name && identity.name === "LinkedIn member") identity.name = userInfo.name;
        } catch (error) {
          console.error("LinkedIn userinfo was not used:", error.message);
        }
      }
      const sessionToken = await signSession({
        sub: identity.sub,
        name: identity.name,
        csrf: randomToken(),
      }, config.sessionSecret);
      res.append("Set-Cookie", cookieHeader(SESSION_COOKIE, sessionToken, { maxAge: SESSION_SECONDS, secure }));
      res.append("Set-Cookie", cookieHeader(OAUTH_COOKIE, "", { maxAge: 0, secure }));
      res.redirect("/");
    } catch (error) {
      console.error("LinkedIn sign-in failed:", error.message);
      fail("linkedin_token");
    }
  });

  app.post("/auth/logout", async (req, res) => {
    const session = await requireSession(req, res);
    if (!session) return;
    res.setHeader("Set-Cookie", cookieHeader(SESSION_COOKIE, "", {
      maxAge: 0,
      secure: requestIsSecure(req),
    }));
    res.json({ ok: true });
  });

  app.post("/api/research", async (req, res) => {
    const session = await requireSession(req, res);
    if (!session) return;
    if (!allowResearch(session.sub)) {
      res.status(429).json({ error: "Too many lookups. Wait a while and try again." });
      return;
    }
    const query = req.body?.query;
    try {
      parseLookup(query);
    } catch (error) {
      res.status(400).json({ error: error.message });
      return;
    }
    if (!xaiConfigured(config)) {
      res.status(503).json({
        error: "XAI_API_KEY is not set. Add it to the server environment and try again.",
      });
      return;
    }
    pruneJobs();
    const id = randomToken();
    const job = {
      id,
      owner: session.sub,
      status: "running",
      step: "planning",
      result: null,
      error: null,
      createdAt: Date.now(),
    };
    jobs.set(id, job);
    res.status(202).json({ id, status: job.status, step: job.step });
    Promise.resolve()
      .then(() => research({
        rawQuery: query,
        now: new Date(),
        onStatus: (step) => {
          job.step = step;
        },
      }))
      .then((result) => {
        job.status = "done";
        job.step = "done";
        job.result = result;
      })
      .catch((error) => {
        job.status = "error";
        job.error = error instanceof ResearchError
          ? { code: error.code, message: error.message }
          : { code: "research_failed", message: "The lookup failed before a sourced result was ready." };
        console.error("Research failed:", error.message);
      });
  });

  app.get("/api/research/:id", async (req, res) => {
    const session = await requireSession(req, res, { csrf: false });
    if (!session) return;
    pruneJobs();
    const job = jobs.get(req.params.id);
    if (!job || job.owner !== session.sub) {
      res.status(404).json({ error: "This lookup is no longer available. Run it again." });
      return;
    }
    res.setHeader("Cache-Control", "no-store");
    res.json({
      id: job.id,
      status: job.status,
      step: job.step,
      result: job.status === "done" ? job.result : null,
      error: job.error,
    });
  });

  app.use(express.static(publicDir, { index: "index.html" }));
  app.use((_req, res) => {
    res.status(404).json({ error: "Not found" });
  });

  return app;

  async function requireSession(req, res, { csrf = true } = {}) {
    const session = await readSession(req, config.sessionSecret);
    if (!session) {
      res.status(401).json({ error: "Sign in with LinkedIn to run a lookup." });
      return null;
    }
    if (csrf && !sameToken(session.csrf, req.get("x-csrf-token") || "")) {
      res.status(403).json({ error: "The form token did not match. Reload the page and try again." });
      return null;
    }
    return session;
  }

  function allowResearch(sub) {
    const now = Date.now();
    const recent = (rateLimits.get(sub) || []).filter((time) => now - time < 60 * 60 * 1000);
    if (recent.length >= 8) {
      rateLimits.set(sub, recent);
      return false;
    }
    recent.push(now);
    rateLimits.set(sub, recent);
    return true;
  }

  function pruneJobs() {
    const cutoff = Date.now() - 30 * 60 * 1000;
    for (const [id, job] of jobs) {
      if (job.createdAt < cutoff) jobs.delete(id);
    }
    while (jobs.size > 100) {
      const oldest = jobs.keys().next().value;
      jobs.delete(oldest);
    }
  }
}

function sameToken(left, right) {
  const a = Buffer.from(String(left || ""));
  const b = Buffer.from(String(right || ""));
  if (a.length === 0 || a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function messagePage(title, message) {
  return `<!doctype html><html lang="en"><meta charset="utf-8"><title>${escapeHtml(title)}</title><body style="font-family:Georgia,serif;max-width:36rem;margin:4rem auto;padding:0 1rem"><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p><p><a href="/">Back</a></p></body></html>`;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[char]));
}

export function start(env = process.env) {
  const config = loadConfig(env);
  if (!config.sessionSecret || config.sessionSecret.length < 32) {
    if (config.nodeEnv === "production") {
      console.error("SESSION_SECRET must be set to at least 32 characters.");
      process.exit(1);
    }
    config.sessionSecret = randomBytes(32).toString("base64url");
    console.warn("SESSION_SECRET is not set. Using a temporary secret for this process.");
  }
  const server = createApp({ config }).listen(config.port, "0.0.0.0");
  console.log(`Listening on ${config.port}`);
  return server;
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) start();
