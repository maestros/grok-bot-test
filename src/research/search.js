import { hostnameBlocked } from "../security/ssrf.js";

const USER_AGENT = "ColleaguesResearch/1.0 (public page research)";

export async function searchWeb(query, { braveKey = "", fetchImpl = fetch } = {}) {
  const reports = [];
  const results = [];
  const duck = await duckDuckGoSearch(query, fetchImpl);
  reports.push(duck.report);
  results.push(...duck.results);
  if (!braveKey) {
    reports.push({ name: "Brave Search", status: "skipped", detail: "BRAVE_SEARCH_API_KEY is not set" });
  } else {
    const brave = await braveSearch(query, braveKey, fetchImpl);
    reports.push(brave.report);
    results.push(...brave.results);
  }
  return { reports, results: uniquePublicResults(results) };
}

export async function wikipediaSearch(query, fetchImpl = fetch) {
  const url = `https://en.wikipedia.org/w/api.php?action=opensearch&search=${encodeURIComponent(query)}&limit=3&namespace=0&format=json`;
  try {
    const response = await fetchImpl(url, {
      headers: { Accept: "application/json", "User-Agent": USER_AGENT },
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) {
      return { report: { name: "Wikipedia", status: "failed", detail: `HTTP ${response.status}` }, results: [] };
    }
    const payload = await response.json();
    const titles = Array.isArray(payload?.[1]) ? payload[1] : [];
    const urls = Array.isArray(payload?.[3]) ? payload[3] : [];
    const results = titles.map((title, index) => ({ url: urls[index], title })).filter((item) => item.url);
    return {
      report: { name: "Wikipedia", status: results.length ? "used" : "used", detail: `${results.length} result(s)` },
      results: uniquePublicResults(results),
    };
  } catch {
    return { report: { name: "Wikipedia", status: "failed", detail: "Wikipedia could not be reached" }, results: [] };
  }
}

export async function duckDuckGoSearch(query, fetchImpl = fetch) {
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  try {
    const response = await fetchImpl(url, {
      headers: { Accept: "text/html", "User-Agent": USER_AGENT },
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) {
      return { report: { name: "DuckDuckGo", status: "failed", detail: `HTTP ${response.status}` }, results: [] };
    }
    const html = await response.text();
    const results = parseDuckDuckGoHtml(html);
    return {
      report: { name: "DuckDuckGo", status: "used", detail: `${results.length} result(s)` },
      results,
    };
  } catch {
    return { report: { name: "DuckDuckGo", status: "failed", detail: "DuckDuckGo could not be reached" }, results: [] };
  }
}

export function parseDuckDuckGoHtml(html) {
  const results = [];
  for (const match of String(html || "").matchAll(/<a\b[^>]*class="[^"]*result__a[^"]*"[^>]*>/gi)) {
    const tag = match[0];
    const href = tag.match(/href="([^"]+)"/i)?.[1];
    if (!href) continue;
    const destination = duckDestination(href);
    if (!destination) continue;
    results.push({ url: destination, title: "" });
  }
  return uniquePublicResults(results);
}

export function duckDestination(href) {
  const decoded = href.replace(/&amp;/g, "&");
  try {
    const url = new URL(decoded, "https://duckduckgo.com");
    const wrapped = url.searchParams.get("uddg");
    const candidate = wrapped || (url.hostname.endsWith("duckduckgo.com") ? null : url.toString());
    if (!candidate) return null;
    const target = new URL(candidate);
    if (target.protocol !== "http:" && target.protocol !== "https:") return null;
    if (hostnameBlocked(target.hostname)) return null;
    return target.toString();
  } catch {
    return null;
  }
}

async function braveSearch(query, apiKey, fetchImpl) {
  const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=5`;
  try {
    const response = await fetchImpl(url, {
      headers: {
        Accept: "application/json",
        "X-Subscription-Token": apiKey,
      },
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) {
      return { report: { name: "Brave Search", status: "failed", detail: `HTTP ${response.status}` }, results: [] };
    }
    const payload = await response.json();
    const web = payload?.web?.results || [];
    const results = web
      .map((item) => ({ url: item.url, title: item.title || "" }))
      .filter((item) => item.url);
    return {
      report: { name: "Brave Search", status: "used", detail: `${results.length} result(s)` },
      results: uniquePublicResults(results),
    };
  } catch {
    return { report: { name: "Brave Search", status: "failed", detail: "Brave Search could not be reached" }, results: [] };
  }
}

function uniquePublicResults(results) {
  const seen = new Set();
  const unique = [];
  for (const result of results) {
    let url;
    try {
      url = new URL(result.url);
    } catch {
      continue;
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") continue;
    if (hostnameBlocked(url.hostname)) continue;
    url.hash = "";
    const key = url.toString();
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push({ url: key, title: result.title || "" });
  }
  return unique;
}
