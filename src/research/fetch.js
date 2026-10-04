import { htmlToDocument } from "./html.js";
import { assertPublicHttpUrl } from "../security/ssrf.js";

const USER_AGENT = "ColleaguesResearch/1.0 (public page research)";
const MAX_BYTES = 1_000_000;

export async function fetchPublicPage(rawUrl, { fetchImpl = fetch } = {}) {
  let current = String(rawUrl);
  const seen = new Set();
  for (let hop = 0; hop < 4; hop += 1) {
    if (seen.has(current)) return failed(rawUrl, "Redirect loop");
    seen.add(current);
    let url;
    try {
      url = await assertPublicHttpUrl(current);
    } catch (error) {
      return failed(rawUrl, error.message);
    }
    let response;
    try {
      response = await fetchImpl(url, {
        redirect: "manual",
        headers: {
          Accept: "text/html,application/xhtml+xml,text/plain;q=0.9",
          "User-Agent": USER_AGENT,
        },
        signal: AbortSignal.timeout(12000),
      });
    } catch {
      return failed(rawUrl, "The page could not be downloaded");
    }
    const status = response.status;
    if ([301, 302, 303, 307, 308].includes(status)) {
      const location = header(response, "location");
      if (!location) return failed(rawUrl, "Redirect had no destination");
      try {
        current = new URL(location, url).toString();
      } catch {
        return failed(rawUrl, "Redirect destination was invalid");
      }
      continue;
    }
    if (status < 200 || status >= 300) return failed(rawUrl, `HTTP ${status}`);
    const type = header(response, "content-type");
    if (type && !/text\/html|text\/plain|application\/xhtml\+xml|application\/json/i.test(type)) {
      return failed(rawUrl, "Unsupported page type");
    }
    let buffer;
    try {
      buffer = await readLimited(response, MAX_BYTES);
    } catch {
      return failed(rawUrl, "Page is too large");
    }
    const document = htmlToDocument(buffer.toString("utf8"), url.toString());
    return {
      url: String(rawUrl),
      finalUrl: url.toString(),
      ok: true,
      title: document.title,
      text: document.text,
      links: document.links,
      structuredPeople: document.structuredPeople,
      error: null,
    };
  }
  return failed(rawUrl, "Too many redirects");
}

function failed(url, error) {
  return {
    url: String(url),
    finalUrl: null,
    ok: false,
    title: "",
    text: "",
    links: [],
    structuredPeople: [],
    error,
  };
}

function header(response, name) {
  if (!response?.headers) return "";
  if (typeof response.headers.get === "function") return response.headers.get(name) || "";
  const entries = Object.entries(response.headers);
  const found = entries.find(([key]) => key.toLowerCase() === name.toLowerCase());
  return found ? String(found[1]) : "";
}

async function readLimited(response, max) {
  if (!response.body || typeof response.body.getReader !== "function") {
    const text = typeof response.text === "function" ? await response.text() : "";
    if (text.length > max) throw new Error("Page is too large");
    return Buffer.from(text);
  }
  const reader = response.body.getReader();
  const chunks = [];
  let received = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > max) {
      await reader.cancel();
      throw new Error("Page is too large");
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}
