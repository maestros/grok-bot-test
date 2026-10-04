import { SignJWT, jwtVerify } from "jose";

export const SESSION_COOKIE = "colleagues_session";
export const OAUTH_COOKIE = "colleagues_oauth";
const SESSION_SECONDS = 60 * 60 * 24 * 7;
const OAUTH_SECONDS = 60 * 10;

function keyFor(secret) {
  if (!secret || secret.length < 32) {
    throw new Error("SESSION_SECRET must be at least 32 characters");
  }
  return new TextEncoder().encode(secret);
}

export async function signPayload(payload, secret, seconds) {
  return new SignJWT(payload)
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(`${seconds}s`)
    .sign(keyFor(secret));
}

export async function verifyPayload(token, secret) {
  const { payload } = await jwtVerify(token, keyFor(secret));
  return payload;
}

export function signSession(session, secret) {
  return signPayload(
    {
      sub: session.sub,
      name: session.name,
      csrf: session.csrf,
    },
    secret,
    SESSION_SECONDS,
  );
}

export function signOauth(oauth, secret) {
  return signPayload(
    { state: oauth.state, nonce: oauth.nonce },
    secret,
    OAUTH_SECONDS,
  );
}

export function readCookies(header) {
  const cookies = {};
  if (!header) return cookies;
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index === -1) continue;
    const name = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (!name) continue;
    try {
      cookies[name] = decodeURIComponent(value);
    } catch {
      cookies[name] = value;
    }
  }
  return cookies;
}

export function cookieHeader(name, value, { maxAge, secure }) {
  const pieces = [
    `${name}=${encodeURIComponent(value)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${maxAge}`,
  ];
  if (secure) pieces.push("Secure");
  return pieces.join("; ");
}

export function requestIsSecure(req) {
  return Boolean(req.secure || req.headers["x-forwarded-proto"] === "https");
}

export async function readSession(req, secret) {
  if (!secret) return null;
  const token = readCookies(req.headers.cookie)[SESSION_COOKIE];
  if (!token) return null;
  try {
    const payload = await verifyPayload(token, secret);
    if (!payload.sub || !payload.csrf) return null;
    return {
      sub: String(payload.sub),
      name: String(payload.name || "LinkedIn member"),
      csrf: String(payload.csrf),
    };
  } catch {
    return null;
  }
}
