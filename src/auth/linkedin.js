import { createRemoteJWKSet, jwtVerify } from "jose";
import { randomBytes } from "node:crypto";

const AUTHORIZATION_ENDPOINT = "https://www.linkedin.com/oauth/v2/authorization";
const TOKEN_ENDPOINT = "https://www.linkedin.com/oauth/v2/accessToken";
const USERINFO_ENDPOINT = "https://api.linkedin.com/v2/userinfo";
const JWKS_URI = "https://www.linkedin.com/oauth/openid/jwks";
const ISSUER = "https://www.linkedin.com/oauth";

let jwks;

function getJwks() {
  if (!jwks) jwks = createRemoteJWKSet(new URL(JWKS_URI));
  return jwks;
}

export function randomToken() {
  return randomBytes(32).toString("base64url");
}

export function buildAuthorizationUrl({ clientId, callbackUrl, state, nonce }) {
  const url = new URL(AUTHORIZATION_ENDPOINT);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", callbackUrl);
  url.searchParams.set("state", state);
  url.searchParams.set("nonce", nonce);
  url.searchParams.set("scope", "openid profile email");
  return url.toString();
}

export async function exchangeCode({ code, clientId, clientSecret, callbackUrl, fetchImpl = fetch }) {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: callbackUrl,
    client_id: clientId,
    client_secret: clientSecret,
  });
  const response = await fetchImpl(TOKEN_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body,
    signal: AbortSignal.timeout(15000),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const reason = payload.error || `HTTP ${response.status}`;
    throw new Error(`LinkedIn token exchange failed (${reason})`);
  }
  return payload;
}

export async function verifyIdToken({ idToken, clientId, nonce }) {
  const { payload } = await jwtVerify(idToken, getJwks(), {
    issuer: ISSUER,
    audience: clientId,
    clockTolerance: 10,
  });
  if (!payload.nonce || payload.nonce !== nonce) {
    throw new Error("LinkedIn login nonce did not match");
  }
  if (!payload.sub) throw new Error("LinkedIn ID token has no subject");
  return identityFromClaims(payload);
}

export async function fetchUserInfo({ accessToken, fetchImpl = fetch }) {
  const response = await fetchImpl(USERINFO_ENDPOINT, {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
    signal: AbortSignal.timeout(15000),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`LinkedIn userinfo failed (HTTP ${response.status})`);
  }
  return identityFromClaims(payload);
}

export function identityFromClaims(claims) {
  const given = [claims.given_name, claims.family_name].filter(Boolean).join(" ").trim();
  const name = String(claims.name || given || "LinkedIn member").slice(0, 200);
  return {
    sub: String(claims.sub),
    name,
  };
}
