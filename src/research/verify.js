import { yearsInText } from "./dates.js";
import {
  acceptablePersonName,
  companyTokens,
  nameTokens,
  normalizeText,
  tokensInOrder,
  words,
} from "./text.js";

const CURRENT_WORD = /\b(present|currently|current|since|today)\b/i;

export function verifyRole({ personName, role, pageText, allowedUrls, allowOrgChart = false }) {
  if (!acceptablePersonName(personName)) return drop("nameNotUsable");
  const quote = String(role?.evidence || "").trim();
  const normalizedQuote = normalizeText(quote);
  if (normalizedQuote.length < 24) return drop("quoteTooShort");
  if (quote.length > 500) return drop("quoteTooLong");
  const sourceUrl = canonicalUrl(role?.sourceUrl);
  if (!sourceUrl || !allowedUrls.has(sourceUrl)) return drop("sourceNotFetched");
  const page = pageText.get(sourceUrl);
  if (!page || !normalizeText(page).includes(normalizedQuote)) return drop("quoteNotInSource");
  if (!tokensInOrder(words(quote), nameTokens(personName))) return drop("nameNotInQuote");
  const company = cleanLabel(role?.company);
  if (!company || !tokensInOrder(words(quote), companyTokens(company))) return drop("companyNotInQuote");

  const verified = {
    personName: cleanLabel(personName),
    company,
    title: supportedLabel(role?.title, quote),
    team: supportedLabel(role?.team, quote),
    start: null,
    end: null,
    current: false,
    currentBasis: null,
    sourceUrl,
    evidence: quote,
  };

  const years = new Set(yearsInText(quote));
  if (role?.start) {
    const year = String(role.start).slice(0, 4);
    if (years.has(year)) verified.start = String(role.start);
  }
  if (role?.end) {
    const year = String(role.end).slice(0, 4);
    if (years.has(year)) verified.end = String(role.end);
  }
  if (allowOrgChart && role?.currentBasis === "org_chart") {
    verified.current = true;
    verified.currentBasis = "org_chart";
  } else if (role?.current && CURRENT_WORD.test(quote)) {
    verified.current = true;
    verified.currentBasis = "source_text";
  }
  return { ok: true, role: verified };
}

function supportedLabel(value, quote) {
  const label = cleanLabel(value);
  if (!label) return null;
  const tokens = words(label).filter((token) => token.length >= 2);
  if (!tokens.length || !tokensInOrder(words(quote), tokens)) return null;
  return label;
}

function cleanLabel(value) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return text ? text.slice(0, 160) : null;
}

function canonicalUrl(value) {
  try {
    const url = new URL(String(value));
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    url.hash = "";
    if (url.pathname.length > 1) url.pathname = url.pathname.replace(/\/+$/, "");
    return url.toString();
  } catch {
    return null;
  }
}

export function pageKey(value) {
  return canonicalUrl(value);
}

function drop(reason) {
  return { ok: false, reason };
}
