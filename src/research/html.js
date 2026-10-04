import { acceptablePersonName } from "./text.js";

const NAMED_ENTITIES = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

export function decodeEntities(value) {
  return String(value || "").replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (entity, body) => {
    if (body[0] === "#") {
      const codePoint = body[1] === "x" || body[1] === "X"
        ? Number.parseInt(body.slice(2), 16)
        : Number.parseInt(body.slice(1), 10);
      if (!Number.isInteger(codePoint) || codePoint < 0 || codePoint > 0x10ffff) return " ";
      return String.fromCodePoint(codePoint);
    }
    return Object.hasOwn(NAMED_ENTITIES, body.toLowerCase()) ? NAMED_ENTITIES[body.toLowerCase()] : " ";
  });
}

export function htmlToDocument(html, pageUrl = "") {
  const source = preferArticle(String(html || ""));
  const titleMatch = source.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch ? cleanText(decodeEntities(titleMatch[1])) : "";
  const structured = extractStructuredPeople(source, pageUrl);
  const withoutScripts = source
    .replace(/<script[^>]*type=["']application\/ld\+json["'][^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ");
  const links = [...withoutScripts.matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>/gi)]
    .map((match) => match[1])
    .map((href) => resolveLink(href, pageUrl))
    .filter(Boolean);
  const textBody = cleanText(
    decodeEntities(
      withoutScripts
        .replace(/<(br|\/p|\/div|\/li|\/tr|\/h[1-6])\b[^>]*>/gi, "\n")
        .replace(/<[^>]+>/g, " "),
    ),
  );
  const structuredLines = structured.map((person) => person.evidence);
  const text = [title, textBody, ...structuredLines].filter(Boolean).join("\n");
  return {
    title,
    text: text.slice(0, 30000),
    links: [...new Set(links)].slice(0, 40),
    structuredPeople: structured,
  };
}

function preferArticle(html) {
  const marker = html.search(/id=["']mw-content-text["']/i);
  if (marker === -1) return html;
  const start = html.lastIndexOf("<", marker);
  const rest = html.slice(start === -1 ? marker : start);
  const end = rest.search(/id=["']catlinks["']/i);
  const title = html.match(/<title[^>]*>[\s\S]*?<\/title>/i)?.[0] || "";
  return `${title}\n${end === -1 ? rest : rest.slice(0, end)}`;
}

function resolveLink(href, pageUrl) {
  try {
    const url = new URL(href, pageUrl || undefined);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

function extractStructuredPeople(html, pageUrl) {
  const people = [];
  const seen = new Set();
  for (const match of html.matchAll(
    /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi,
  )) {
    const raw = decodeEntities(match[1]).trim();
    if (!raw) continue;
    try {
      walkJsonLd(JSON.parse(raw), people, null, new Set(), hostOf(pageUrl));
    } catch {
      // Ignore broken structured data. Visible text can still be used.
    }
  }
  return people.filter((person) => {
    const key = `${person.name}|${person.title || ""}|${person.company || ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return acceptablePersonName(person.name) && person.company;
  });
}

function hostOf(pageUrl) {
  try {
    return new URL(pageUrl).hostname.toLowerCase();
  } catch {
    return "";
  }
}

function walkJsonLd(node, people, inheritedCompany, seen, host) {
  if (!node || typeof node !== "object") return;
  if (seen.has(node)) return;
  seen.add(node);
  if (Array.isArray(node)) {
    for (const item of node) walkJsonLd(item, people, inheritedCompany, seen, host);
    return;
  }
  const types = nodeTypes(node["@type"]);
  if (types.includes("organization") && Array.isArray(node.employee)) {
    const company = textValue(node.name) || inheritedCompany;
    for (const employee of node.employee) {
      recordPerson(employee, company, people, host);
      walkJsonLd(employee, people, company, seen, host);
    }
  }
  if (types.includes("person")) {
    recordPerson(node, inheritedCompany || organizationName(node.worksFor) || organizationName(node.affiliation), people, host);
  }
  for (const value of Object.values(node)) {
    if (value && typeof value === "object") walkJsonLd(value, people, inheritedCompany, seen, host);
  }
}

function recordPerson(node, company, people, host) {
  const name = textValue(node?.name);
  const title = textValue(node?.jobTitle);
  const organization = company || organizationName(node?.worksFor) || organizationName(node?.affiliation);
  if (!name || !organization) return;
  const orgChart = host === "theorg.com" || host.endsWith(".theorg.com");
  const evidence = [
    `Listed person: ${name}.`,
    title ? `Title: ${title}.` : null,
    `Organization: ${organization}.`,
  ].filter(Boolean).join(" ");
  people.push({
    name,
    title: title || null,
    company: organization,
    team: null,
    start: null,
    end: null,
    current: orgChart,
    currentBasis: orgChart ? "org_chart" : null,
    evidence,
  });
}

function organizationName(value) {
  if (!value) return null;
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return organizationName(value[0]);
  return textValue(value.name);
}

function textValue(value) {
  if (typeof value === "string") return cleanText(value);
  if (Array.isArray(value)) return textValue(value[0]);
  return null;
}

function nodeTypes(type) {
  const values = Array.isArray(type) ? type : type ? [type] : [];
  return values.map((item) => String(item).toLowerCase().replace(/^https?:\/\/schema\.org\//, ""));
}

function cleanText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}
