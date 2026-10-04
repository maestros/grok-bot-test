import assert from "node:assert/strict";
import { generateKeyPair, SignJWT } from "jose";
import test from "node:test";
import { verifyIdToken } from "../src/auth/linkedin.js";

const issuer = "https://www.linkedin.com/oauth";
const clientId = "client-id";

test("an ID token with no nonce claim still signs the user in", async () => {
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const storedNonce = "stored-nonce-value";
  const withoutNonce = await signToken(privateKey, { sub: "person-1", name: "Pat Example" });
  const identity = await verifyIdToken({
    idToken: withoutNonce,
    clientId,
    nonce: storedNonce,
    jwks: publicKey,
  });
  assert.deepEqual(identity, { sub: "person-1", name: "Pat Example" });

  const matching = await signToken(privateKey, {
    sub: "person-1",
    name: "Pat Example",
    nonce: storedNonce,
  });
  const matched = await verifyIdToken({
    idToken: matching,
    clientId,
    nonce: storedNonce,
    jwks: publicKey,
  });
  assert.equal(matched.sub, "person-1");

  const mismatched = await signToken(privateKey, {
    sub: "person-1",
    name: "Pat Example",
    nonce: "other-nonce",
  });
  await assert.rejects(
    () => verifyIdToken({ idToken: mismatched, clientId, nonce: storedNonce, jwks: publicKey }),
    /nonce did not match/,
  );

  await assert.rejects(
    () => verifyIdToken({ idToken: withoutNonce, clientId: "other-client", nonce: storedNonce, jwks: publicKey }),
    /unexpected "aud" claim value/,
  );
  const wrongIssuer = await signToken(privateKey, {
    sub: "person-1",
    name: "Pat Example",
    iss: "https://example.com",
  });
  await assert.rejects(
    () => verifyIdToken({ idToken: wrongIssuer, clientId, nonce: storedNonce, jwks: publicKey }),
    /unexpected "iss" claim value/,
  );
});

function signToken(privateKey, claims) {
  const { iss, ...rest } = claims;
  return new SignJWT(rest)
    .setProtectedHeader({ alg: "RS256" })
    .setIssuer(iss || issuer)
    .setAudience(clientId)
    .setIssuedAt()
    .setExpirationTime("2m")
    .sign(privateKey);
}
