const YEAR = /^(\d{4})$/;
const YEAR_MONTH = /^(\d{4})-(0[1-9]|1[0-2])$/;

export function parseBound(value) {
  if (value == null || value === "") return null;
  const text = String(value).trim();
  const monthMatch = text.match(YEAR_MONTH);
  if (monthMatch) {
    const year = Number(monthMatch[1]);
    if (year < 1950 || year > 2100) return null;
    return { year, month: Number(monthMatch[2]), precision: "month" };
  }
  const yearMatch = text.match(YEAR);
  if (!yearMatch) return null;
  const year = Number(yearMatch[1]);
  if (year < 1950 || year > 2100) return null;
  return { year, month: null, precision: "year" };
}

export function startIndex(bound) {
  return bound.year * 12 + ((bound.month ?? 1) - 1);
}

export function endIndex(bound) {
  return bound.year * 12 + ((bound.month ?? 12) - 1);
}

export function nowIndex(date) {
  return date.getUTCFullYear() * 12 + date.getUTCMonth();
}

export function formatIndex(index, precision) {
  const year = Math.floor(index / 12);
  const month = (index % 12) + 1;
  if (precision === "year") return String(year);
  return `${year}-${String(month).padStart(2, "0")}`;
}

export function yearsInText(value) {
  return [...String(value || "").matchAll(/\b(?:19|20)\d{2}\b/g)].map((match) => match[0]);
}
