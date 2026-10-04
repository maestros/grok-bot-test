import { ResearchError } from "../errors.js";
import { nameTokens } from "./text.js";

export function parseLookup(raw) {
  const query = String(raw || "").trim();
  if (!query) {
    throw new ResearchError("bad_input", "Enter a person's name or a public LinkedIn profile URL.");
  }
  if (query.length > 300) {
    throw new ResearchError("bad_input", "That lookup is too long.");
  }
  if (/^https?:\/\//i.test(query)) {
    return parseLinkedInProfile(query);
  }
  if (query.includes("://") || /\s+\.\s+/.test(query)) {
    throw new ResearchError("bad_input", "Enter a person's name or a public LinkedIn profile URL.");
  }
  if (!/[a-z]/i.test(query)) {
    throw new ResearchError("bad_input", "Enter a person's name or a public LinkedIn profile URL.");
  }
  const tokens = nameTokens(query);
  if (!tokens.length) {
    throw new ResearchError("bad_input", "Enter a clearer name.");
  }
  return {
    raw: query,
    kind: "name",
    displayName: query,
    slug: null,
    queryTokens: tokens,
  };
}

function parseLinkedInProfile(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new ResearchError("bad_input", "That LinkedIn URL could not be read.");
  }
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  const linkedInHost = host === "linkedin.com" || host.endsWith(".linkedin.com");
  const match = url.pathname.match(/^\/in\/([^/]+)\/?$/);
  if (!linkedInHost || !match) {
    throw new ResearchError(
      "bad_input",
      "Use a public profile URL that looks like https://www.linkedin.com/in/name, or enter a name. This app does not open LinkedIn pages.",
    );
  }
  let slug;
  try {
    slug = decodeURIComponent(match[1]);
  } catch {
    throw new ResearchError("bad_input", "That LinkedIn profile URL could not be read.");
  }
  if (!/^[A-Za-z0-9._-]{2,120}$/.test(slug)) {
    throw new ResearchError("bad_input", "That LinkedIn profile URL could not be read.");
  }
  const parts = slug.split(/[-_.]+/).filter(Boolean);
  while (parts.length > 1 && /\d/.test(parts[parts.length - 1])) parts.pop();
  const displayName = parts.join(" ");
  const tokens = nameTokens(displayName);
  if (!tokens.length) {
    throw new ResearchError("bad_input", "That LinkedIn profile URL did not contain a usable name.");
  }
  return {
    raw,
    kind: "linkedin_url",
    displayName,
    slug,
    queryTokens: tokens,
  };
}
