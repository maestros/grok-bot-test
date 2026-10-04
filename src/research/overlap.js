import { endIndex, formatIndex, nowIndex, parseBound, startIndex } from "./dates.js";
import { companyTokens, samePerson, words } from "./text.js";

export function companiesMatch(left, right) {
  const a = companyTokens(left);
  const b = companyTokens(right);
  if (!a.length || !b.length) return false;
  return a.join(" ") === b.join(" ") || words(left).join(" ") === words(right).join(" ");
}

export function teamRelation(left, right) {
  const a = words(left || "").join(" ");
  const b = words(right || "").join(" ");
  if (a && b) return a === b ? "same" : "different";
  return "unknown";
}

export function computeOverlap(left, right, now) {
  const leftRange = roleRange(left);
  const rightRange = roleRange(right);
  if (!leftRange || !rightRange) {
    if (left.current && right.current) {
      return {
        status: "current",
        start: null,
        end: null,
        note: "Both are listed in current roles. At least one start date was not published, so the length of the overlap is unknown.",
      };
    }
    return {
      status: "unestablished",
      start: null,
      end: null,
      note: "The pages do not give enough dates to show these people were there at the same time.",
    };
  }
  const start = Math.max(leftRange.start, rightRange.start);
  const end = combineEnd(leftRange.end, rightRange.end);
  if (end != null && start > end) {
    return {
      status: "none",
      start: null,
      end: null,
      note: "The published date ranges do not overlap.",
    };
  }
  const precision = coarser(leftRange, rightRange, start, end);
  const includesNow = end == null || end >= nowIndex(now);
  return {
    status: includesNow ? "current" : "past",
    start: formatIndex(start, precision.start),
    end: end == null ? null : formatIndex(end, precision.end),
    note: includesNow
      ? "The published ranges both cover the current month."
      : "The published ranges overlap, and that overlap ended before the current month.",
  };
}

function roleRange(role) {
  const start = parseBound(role.start);
  if (!start) return null;
  const end = parseBound(role.end);
  if (!end && !role.current) return null;
  const startAt = startIndex(start);
  const endAt = end ? endIndex(end) : null;
  if (endAt != null && startAt > endAt) return null;
  return { start: startAt, end: endAt, startPrecision: start.precision, endPrecision: end?.precision || null };
}

function combineEnd(left, right) {
  if (left == null) return right;
  if (right == null) return left;
  return Math.min(left, right);
}

function coarser(leftRange, rightRange, start, end) {
  const startPrecision = leftRange.start === start
    ? leftRange.startPrecision
    : rightRange.start === start
      ? rightRange.startPrecision
      : leftRange.startPrecision === "year" || rightRange.startPrecision === "year"
        ? "year"
        : "month";
  let endPrecision = "month";
  if (end != null) {
    if (leftRange.end === end && rightRange.end === end) {
      endPrecision = leftRange.endPrecision === "year" || rightRange.endPrecision === "year" ? "year" : "month";
    } else if (leftRange.end === end) {
      endPrecision = leftRange.endPrecision || "month";
    } else if (rightRange.end === end) {
      endPrecision = rightRange.endPrecision || "month";
    }
  }
  return { start: startPrecision, end: endPrecision };
}

export function relateColleague(subjectRole, otherRole, now) {
  if (samePerson(subjectRole.personName, otherRole.personName)) return null;
  if (!companiesMatch(subjectRole.company, otherRole.company)) return null;
  const teams = teamRelation(subjectRole.team, otherRole.team);
  if (teams === "different") return null;
  const overlap = computeOverlap(subjectRole, otherRole, now);
  if (overlap.status === "none") return null;
  const teamLevel = teams === "same";
  return {
    name: otherRole.personName,
    title: otherRole.title,
    company: otherRole.company,
    team: teamLevel ? otherRole.team : null,
    grouping: teamLevel ? "team" : "company",
    groupingLabel: teamLevel ? otherRole.team : otherRole.company,
    overlap,
    sourceUrl: otherRole.sourceUrl,
    evidence: otherRole.evidence,
    subjectSourceUrl: subjectRole.sourceUrl,
  };
}
