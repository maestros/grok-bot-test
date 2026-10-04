import { ResearchError } from "../errors.js";
import { hostnameBlocked } from "../security/ssrf.js";
import { createGrok } from "./grok.js";
import { parseLookup } from "./input.js";
import { fetchPublicPage } from "./fetch.js";
import { searchWeb, wikipediaSearch } from "./search.js";
import { pageKey, verifyRole } from "./verify.js";
import { relateColleague } from "./overlap.js";
import { companyTokens, matchesQuery, nameTokens, samePerson } from "./text.js";

const MAX_PAGES = 8;
const COMPANY_LEVEL_CAP = 30;

const PLAN_SYSTEM = [
  "You plan public web searches that can identify one person's employers and coworkers.",
  "Use only public sources such as theorg.com, Wikipedia, company websites, news bios, and other public biographies.",
  "Never search or open LinkedIn, and never invent a page.",
  "Return only a JSON object with this shape:",
  '{"queries":["search terms"],"urls":["https://example.com/page"],"notes":"short note"}',
  "queries: 3 to 5 search strings.",
  "urls: up to 4 https pages you are confident already exist, or an empty array. No linkedin.com URLs.",
].join(" ");

const EXTRACT_SYSTEM = [
  "You extract employment facts that are written in the supplied public pages.",
  "Return only JSON with this shape:",
  '{"people":[{"name":"","roles":[{"company":"","title":null,"team":null,"start":null,"end":null,"current":false,"sourceUrl":"","evidence":""}]}]}',
  "Rules:",
  "Copy evidence as a contiguous excerpt from the page text. Do not paraphrase.",
  "sourceUrl must be one of the supplied page URLs.",
  "If a start or end date is not written as a year in that excerpt, use null.",
  "Set current to true only when the excerpt presents the role as current, for example with since, current, present, or today.",
  "Do not invent people, titles, dates, companies, or teams.",
  "Include the looked-up person and other people the same page places at the same company or team.",
  "Omit anyone you cannot support with an excerpt.",
].join(" ");

export function createResearchDeps({ config, fetchImpl = fetch }) {
  const grok = createGrok({ ...config.xai, fetchImpl });
  return {
    configured: grok.configured,
    async plan(lookup) {
      return grok.complete(PLAN_SYSTEM, planPrompt(lookup));
    },
    async search(query) {
      return searchWeb(query, { braveKey: config.braveSearchApiKey, fetchImpl });
    },
    async wikipedia(query) {
      return wikipediaSearch(query, fetchImpl);
    },
    async fetchPage(url) {
      return fetchPublicPage(url, { fetchImpl });
    },
    async extract(lookup, pages) {
      return grok.complete(EXTRACT_SYSTEM, extractPrompt(lookup, pages));
    },
  };
}

export async function runResearch({ rawQuery, deps, now = new Date(), onStatus = () => {} }) {
  const lookup = parseLookup(rawQuery);
  if (!deps?.configured) {
    throw new ResearchError(
      "not_configured",
      "XAI_API_KEY is not set. Add it to the server environment and try again.",
    );
  }

  onStatus("planning");
  let plan;
  try {
    plan = await deps.plan(lookup);
  } catch (error) {
    throw asModelError(error);
  }
  const queries = sanitizeQueries(plan?.queries);
  const notes = [];
  if (plan?.notes) notes.push(String(plan.notes).slice(0, 500));

  onStatus("searching");
  const searchReports = [];
  const discovered = [];
  const wiki = await deps.wikipedia(lookup.displayName);
  searchReports.push(wiki.report);
  discovered.push(...wiki.results);
  for (const query of queries) {
    const batch = await deps.search(query);
    searchReports.push(...batch.reports);
    discovered.push(...batch.results);
  }

  const urls = [];
  const seenUrls = new Set();
  const addUrl = (value) => {
    const clean = publicHttpsUrl(value);
    if (!clean || seenUrls.has(clean) || urls.length >= MAX_PAGES) return;
    seenUrls.add(clean);
    urls.push(clean);
  };
  addUrl(`https://theorg.com/search?q=${encodeURIComponent(lookup.displayName)}`);
  for (const url of plan?.urls || []) addUrl(url);
  for (const result of discovered) addUrl(result.url);

  onStatus("reading");
  let pages = await mapPool(urls, 3, (url) => deps.fetchPage(url));
  const extras = theOrgLinks(pages, seenUrls).slice(0, Math.max(0, MAX_PAGES - pages.length));
  if (extras.length) {
    const more = await mapPool(extras, 3, (url) => deps.fetchPage(url));
    pages = pages.concat(more);
  }

  const readable = pages.filter((page) => page.ok && page.text && page.text.length >= 80);
  onStatus("extracting");
  let extracted = { people: [] };
  if (readable.length) {
    try {
      extracted = await deps.extract(lookup, readable);
    } catch (error) {
      const modelError = asModelError(error);
      notes.push(`${modelError.message} Structured data on the fetched pages was still checked.`);
    }
  } else {
    notes.push("No readable public page was found for this lookup.");
  }

  onStatus("verifying");
  const indexed = indexPages(readable);
  const omitted = {};
  const roles = [];

  for (const person of extracted?.people || []) {
    for (const role of person?.roles || []) {
      const checked = verifyRole({
        personName: person?.name,
        role,
        pageText: indexed.text,
        allowedUrls: indexed.allowed,
      });
      if (!checked.ok) {
        omitted[checked.reason] = (omitted[checked.reason] || 0) + 1;
        continue;
      }
      roles.push(checked.role);
    }
  }

  for (const page of readable) {
    const sourceUrl = pageKey(page.finalUrl || page.url);
    for (const person of page.structuredPeople || []) {
      const checked = verifyRole({
        personName: person.name,
        role: { ...person, sourceUrl },
        pageText: indexed.text,
        allowedUrls: indexed.allowed,
        allowOrgChart: true,
      });
      if (!checked.ok) {
        omitted[checked.reason] = (omitted[checked.reason] || 0) + 1;
        continue;
      }
      roles.push(checked.role);
    }
  }

  return assemble({
    lookup,
    roles: dedupeRoles(roles),
    notes,
    omitted,
    pages,
    searchReports: collapseReports(searchReports),
    now,
  });
}

function assemble({ lookup, roles, notes, omitted, pages, searchReports, now }) {
  const subjects = [];
  const seenSubjects = new Set();
  for (const role of roles) {
    if (!matchesQuery(lookup.queryTokens, role.personName)) continue;
    const key = nameTokens(role.personName).join(" ");
    if (seenSubjects.has(key)) continue;
    seenSubjects.add(key);
    subjects.push(role.personName);
  }

  const base = {
    query: {
      raw: lookup.raw,
      kind: lookup.kind,
      name: lookup.displayName,
    },
    subject: null,
    disambiguation: [],
    currentColleagues: [],
    pastColleagues: [],
    unestablished: [],
    sources: pages.map(sourceRecord),
    omitted,
    notes,
    search: searchReports,
  };

  if (subjects.length === 0) {
    base.notes = notes.concat("No fetched page verified an employer for this person.");
    return base;
  }
  if (subjects.length > 1) {
    base.disambiguation = subjects.map((name) => {
      const role = roles.find((item) => samePerson(item.personName, name));
      return { name, sourceUrl: role?.sourceUrl || null };
    });
    base.notes = notes.concat("More than one person matched this lookup. Colleagues were not listed, because that would mix different people.");
    return base;
  }

  const subjectName = subjects[0];
  const subjectRoles = roles.filter((role) => samePerson(role.personName, subjectName));
  const colleagues = [];
  for (const subjectRole of subjectRoles) {
    for (const other of roles) {
      const related = relateColleague(subjectRole, other, now);
      if (related) colleagues.push(related);
    }
  }

  const unique = dedupeColleagues(colleagues);
  const { kept, suppressedCompanies } = capCompanyLevel(unique);
  if (suppressedCompanies.length) {
    notes.push(
      `A public page listed many people at ${suppressedCompanies.join(", ")} without a shared team, so they were not labeled as colleagues.`,
    );
  }

  base.subject = {
    name: subjectName,
    roles: subjectRoles.map(publicRole),
  };
  base.currentColleagues = kept.filter((item) => item.overlap.status === "current");
  base.pastColleagues = kept.filter((item) => item.overlap.status === "past");
  base.unestablished = kept.filter((item) => item.overlap.status === "unestablished");
  base.notes = notes;
  return base;
}

function capCompanyLevel(colleagues) {
  const counts = new Map();
  for (const colleague of colleagues) {
    if (colleague.grouping !== "company") continue;
    const key = companyTokens(colleague.company).join(" ");
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  const suppressed = new Set(
    [...counts.entries()].filter(([, count]) => count > COMPANY_LEVEL_CAP).map(([key]) => key),
  );
  const kept = colleagues.filter((colleague) => {
    if (colleague.grouping !== "company") return true;
    return !suppressed.has(companyTokens(colleague.company).join(" "));
  });
  const suppressedCompanies = colleagues
    .filter((colleague) => suppressed.has(companyTokens(colleague.company).join(" ")))
    .map((colleague) => colleague.company);
  return { kept, suppressedCompanies: [...new Set(suppressedCompanies)] };
}

function dedupeRoles(roles) {
  const seen = new Set();
  const unique = [];
  for (const role of roles) {
    const key = [
      nameTokens(role.personName).join(" "),
      companyTokens(role.company).join(" "),
      role.title || "",
      role.team || "",
      role.start || "",
      role.end || "",
      role.current ? "1" : "0",
    ].join("|");
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(role);
  }
  return unique;
}

function dedupeColleagues(colleagues) {
  const byKey = new Map();
  for (const colleague of colleagues) {
    const key = [
      nameTokens(colleague.name).join(" "),
      companyTokens(colleague.company).join(" "),
      colleague.grouping,
      colleague.overlap.status,
    ].join("|");
    const existing = byKey.get(key);
    if (!existing || overlapScore(colleague) > overlapScore(existing)) byKey.set(key, colleague);
  }
  return [...byKey.values()].sort((left, right) => {
    if (left.grouping !== right.grouping) return left.grouping === "team" ? -1 : 1;
    return left.name.localeCompare(right.name);
  });
}

function overlapScore(colleague) {
  return (colleague.overlap.start ? 2 : 0) + (colleague.overlap.end ? 1 : 0) + (colleague.title ? 1 : 0);
}

function publicRole(role) {
  return {
    company: role.company,
    title: role.title,
    team: role.team,
    start: role.start,
    end: role.end,
    current: role.current,
    currentBasis: role.currentBasis,
    sourceUrl: role.sourceUrl,
    evidence: role.evidence,
  };
}

function sourceRecord(page) {
  return {
    url: page.finalUrl || page.url,
    title: page.title || "",
    ok: Boolean(page.ok),
    error: page.ok ? null : page.error,
  };
}

function indexPages(pages) {
  const text = new Map();
  const allowed = new Set();
  for (const page of pages) {
    for (const candidate of [page.finalUrl, page.url]) {
      const key = pageKey(candidate);
      if (!key) continue;
      allowed.add(key);
      const existing = text.get(key) || "";
      if ((page.text || "").length > existing.length) text.set(key, page.text || "");
    }
  }
  return { text, allowed };
}

function planPrompt(lookup) {
  const lines = [
    `Person: ${lookup.displayName}`,
    `Input type: ${lookup.kind}`,
  ];
  if (lookup.kind === "linkedin_url") {
    lines.push(
      `The user pasted a public LinkedIn profile URL only as an identifier (${lookup.slug}). Do not fetch LinkedIn. Search public pages for this person.`,
    );
  }
  return lines.join("\n");
}

function extractPrompt(lookup, pages) {
  const chunks = pages.map((page) => {
    const url = page.finalUrl || page.url;
    return `URL: ${url}\nTITLE: ${page.title || ""}\nTEXT:\n${page.text.slice(0, 12000)}`;
  });
  return `Look up: ${lookup.displayName}\n\n${chunks.join("\n\n----\n\n")}`;
}

function sanitizeQueries(queries) {
  if (!Array.isArray(queries)) return [];
  const clean = [];
  for (const query of queries) {
    const text = String(query || "").replace(/\s+/g, " ").trim();
    if (text.length < 3 || text.length > 180) continue;
    if (/linkedin\.com|lnkd\.in/i.test(text)) continue;
    clean.push(text);
    if (clean.length === 5) break;
  }
  return clean;
}

function publicHttpsUrl(value) {
  try {
    const url = new URL(String(value));
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    if (hostnameBlocked(url.hostname)) return null;
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

function theOrgLinks(pages, seen) {
  const links = [];
  for (const page of pages) {
    for (const link of page.links || []) {
      const clean = publicHttpsUrl(link);
      if (!clean || seen.has(clean)) continue;
      let url;
      try {
        url = new URL(clean);
      } catch {
        continue;
      }
      const host = url.hostname.toLowerCase();
      if (host !== "theorg.com" && !host.endsWith(".theorg.com")) continue;
      if (!url.pathname.includes("/org/")) continue;
      seen.add(clean);
      links.push(clean);
    }
  }
  return links;
}

function collapseReports(reports) {
  const byName = new Map();
  for (const report of reports) {
    const current = byName.get(report.name) || { name: report.name, status: "skipped", detail: "" };
    if (report.status === "failed" && current.status !== "used") current.status = "failed";
    if (report.status === "used") current.status = "used";
    if (report.status === "skipped" && !current.status) current.status = "skipped";
    current.detail = report.detail || current.detail;
    byName.set(report.name, current);
  }
  return [...byName.values()];
}

function asModelError(error) {
  if (error instanceof ResearchError) return error;
  return new ResearchError("model_failed", "The research model request failed. Try again in a moment.");
}

async function mapPool(items, limit, fn) {
  const results = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await fn(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

export function companiesMatchForTest(left, right) {
  return companiesMatch(left, right);
}
