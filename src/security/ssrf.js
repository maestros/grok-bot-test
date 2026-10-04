import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

const BLOCKED_HOST_SUFFIXES = [
  "linkedin.com",
  "lnkd.in",
  "licdn.com",
  "localhost",
  "local",
  "internal",
  "metadata.google.internal",
];

export function isPrivateAddress(address) {
  const value = String(address || "").toLowerCase().replace(/^\[|\]$/g, "");
  if (!value) return true;
  if (value.includes(":")) {
    if (value === "::1" || value === "::") return true;
    if (value.startsWith("fc") || value.startsWith("fd")) return true;
    if (value.startsWith("fe80")) return true;
    if (value.startsWith("::ffff:")) return isPrivateAddress(value.slice("::ffff:".length));
    return false;
  }
  const parts = value.split(".").map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return true;
  }
  const [a, b] = parts;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  return false;
}

export function hostnameBlocked(hostname) {
  const host = String(hostname || "")
    .toLowerCase()
    .replace(/\.$/, "");
  if (!host || host === "localhost") return true;
  return BLOCKED_HOST_SUFFIXES.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
}

export async function assertPublicHttpUrl(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("Invalid URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Only http and https URLs can be read");
  }
  if (url.username || url.password) {
    throw new Error("URLs with credentials are not read");
  }
  if (url.port && url.port !== "80" && url.port !== "443") {
    throw new Error("Only ports 80 and 443 can be read");
  }
  const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
  if (isIP(hostname)) {
    throw new Error("IP addresses are not fetched");
  }
  if (hostnameBlocked(hostname)) {
    throw new Error("This host is not a public research source");
  }
  let records;
  try {
    records = await lookup(hostname, { all: true, verbatim: true });
  } catch {
    throw new Error("Could not resolve host");
  }
  if (!records.length) throw new Error("Could not resolve host");
  for (const record of records) {
    if (isPrivateAddress(record.address)) {
      throw new Error("This host does not resolve to a public address");
    }
  }
  return url;
}
