const NAME_STOP = new Set(["jr", "sr", "ii", "iii", "iv", "phd", "mba"]);
const COMPANY_SUFFIX = new Set([
  "inc",
  "incorporated",
  "llc",
  "ltd",
  "limited",
  "corp",
  "corporation",
  "company",
  "co",
  "plc",
  "group",
  "the",
]);

export function normalizeText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function words(value) {
  const normalized = normalizeText(value);
  return normalized ? normalized.split(" ") : [];
}

export function nameTokens(value) {
  return words(value).filter((token) => token.length >= 2 && !NAME_STOP.has(token));
}

export function companyTokens(value) {
  const tokens = words(value).filter((token) => !COMPANY_SUFFIX.has(token));
  return tokens.length ? tokens : words(value).filter((token) => token.length >= 2);
}

export function tokensInOrder(haystack, needed) {
  if (!needed.length) return false;
  let index = 0;
  for (const token of haystack) {
    if (token === needed[index]) index += 1;
    if (index === needed.length) return true;
  }
  return false;
}

export function acceptablePersonName(value) {
  const tokens = nameTokens(value);
  if (tokens.length >= 2) return true;
  return tokens.length === 1 && tokens[0].length >= 4;
}

export function samePerson(left, right) {
  const a = nameTokens(left).join(" ");
  const b = nameTokens(right).join(" ");
  return Boolean(a) && a === b;
}

export function matchesQuery(queryTokens, personName) {
  return tokensInOrder(nameTokens(personName), queryTokens);
}
