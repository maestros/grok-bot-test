import assert from "node:assert/strict";
import test from "node:test";
import { parseBound } from "../src/research/dates.js";
import { htmlToDocument } from "../src/research/html.js";
import { parseLookup } from "../src/research/input.js";
import { computeOverlap, relateColleague } from "../src/research/overlap.js";
import { runResearch } from "../src/research/pipeline.js";
import { parseDuckDuckGoHtml } from "../src/research/search.js";
import { verifyRole } from "../src/research/verify.js";
import { parseModelJson, responseText } from "../src/research/grok.js";

const now = new Date("2026-10-04T00:00:00Z");

test("parses a name and a public LinkedIn profile without opening it", () => {
  const name = parseLookup("  Patrick Collison ");
  assert.equal(name.kind, "name");
  assert.deepEqual(name.queryTokens, ["patrick", "collison"]);

  const profile = parseLookup("https://www.linkedin.com/in/patrick-collison-92ab12/?trk=public");
  assert.equal(profile.kind, "linkedin_url");
  assert.equal(profile.slug, "patrick-collison-92ab12");
  assert.equal(profile.displayName, "patrick collison");
  assert.deepEqual(profile.queryTokens, ["patrick", "collison"]);

  assert.throws(() => parseLookup("https://www.linkedin.com/company/stripe"), /does not open LinkedIn pages/);
  assert.throws(() => parseLookup("https://example.com/people/ada"), /or enter a name/);
});

test("reads organization people from public structured data", () => {
  const html = `<!doctype html><title>Stripe | The Org</title>
    <script type="application/ld+json">
      {"@context":"https://schema.org","@type":"Organization","name":"Stripe","employee":[
        {"@type":"Person","name":"Patrick Collison","jobTitle":"CEO"},
        {"@type":"Person","name":"John Collison","jobTitle":"President"}
      ]}
    </script>`;
  const doc = htmlToDocument(html, "https://theorg.com/org/stripe");
  assert.equal(doc.structuredPeople.length, 2);
  assert.equal(doc.structuredPeople[0].currentBasis, "org_chart");
  assert.match(doc.text, /Listed person: Patrick Collison/);
  const article = htmlToDocument(`<title>Example</title><nav>Ignore this navigation</nav><div id="mw-content-text">Ada Lovelace worked at Example from 1842.</div><div id="catlinks">Categories</div>`, "https://en.wikipedia.org/wiki/Example");
  assert.match(article.text, /Ada Lovelace worked at Example from 1842/);
  assert.equal(article.text.includes("Ignore this navigation"), false);
  const otherHost = htmlToDocument(html, "https://example.com/stripe");
  assert.equal(otherHost.structuredPeople[0].current, false);
});

test("drops a claim the fetched page does not contain", () => {
  const pages = new Map([[
    "https://example.com/bio",
    "Patrick Collison is CEO of Stripe since 2010.",
  ]]);
  const allowed = new Set(pages.keys());
  const supported = verifyRole({
    personName: "Patrick Collison",
    role: {
      company: "Stripe",
      title: "CEO",
      start: "2010",
      current: true,
      sourceUrl: "https://example.com/bio",
      evidence: "Patrick Collison is CEO of Stripe since 2010.",
    },
    pageText: pages,
    allowedUrls: allowed,
  });
  assert.equal(supported.ok, true);
  assert.equal(supported.role.start, "2010");
  assert.equal(supported.role.current, true);

  const inventedDate = verifyRole({
    personName: "Patrick Collison",
    role: {
      company: "Stripe",
      title: "Chief Jester",
      start: "1999",
      current: true,
      currentBasis: "org_chart",
      sourceUrl: "https://example.com/bio",
      evidence: "Patrick Collison is CEO of Stripe since 2010.",
    },
    pageText: pages,
    allowedUrls: allowed,
  });
  assert.equal(inventedDate.ok, true);
  assert.equal(inventedDate.role.title, null);
  assert.equal(inventedDate.role.start, null);
  assert.equal(inventedDate.role.current, true);
  assert.equal(inventedDate.role.currentBasis, "source_text");

  const inventedPerson = verifyRole({
    personName: "Ada Lovelace",
    role: {
      company: "Stripe",
      sourceUrl: "https://example.com/bio",
      evidence: "Ada Lovelace worked at Stripe from 1999 to 2001.",
    },
    pageText: pages,
    allowedUrls: allowed,
  });
  assert.equal(inventedPerson.ok, false);
  assert.equal(inventedPerson.reason, "quoteNotInSource");
});

test("overlap uses published dates and refuses a guess", () => {
  const past = computeOverlap(
    { start: "2018", end: "2020", current: false },
    { start: "2019", end: "2021", current: false },
    now,
  );
  assert.equal(past.status, "past");
  assert.equal(past.start, "2019");
  assert.equal(past.end, "2020");

  const current = computeOverlap(
    { start: "2010", end: null, current: true },
    { start: "2010", end: null, current: true },
    now,
  );
  assert.equal(current.status, "current");
  assert.equal(current.end, null);

  const none = computeOverlap(
    { start: "2010", end: "2012", current: false },
    { start: "2015", end: "2018", current: false },
    now,
  );
  assert.equal(none.status, "none");

  const unknown = computeOverlap(
    { start: "2010", end: "2018", current: false },
    { start: null, end: null, current: true },
    now,
  );
  assert.equal(unknown.status, "unestablished");

  const differentTeam = relateColleague(
    { personName: "Patrick Collison", company: "Stripe", team: "Office of the CEO", start: "2010", current: true },
    { personName: "Priya Nair", company: "Stripe", team: "Sales", start: "2016", current: true },
    now,
  );
  assert.equal(differentTeam, null);
  assert.ok(parseBound("2010-13") === null);
});

test("verified colleagues keep sourced overlaps and drop inventions", async () => {
  const url = "https://example.com/bio";
  const text = [
    "Patrick Collison is CEO of Stripe since 2010 on the Office of the CEO team.",
    "John Collison is President of Stripe since 2010 on the Office of the CEO team.",
    "Claire Hughes Johnson was Corporate Officer at Stripe from 2014 to 2021.",
    "Priya Nair leads Sales at Stripe since 2016.",
    "Robin Lee is a designer at Stripe.",
  ].join(" ");
  const fetched = [];
  const result = await runResearch({
    rawQuery: "https://www.linkedin.com/in/patrick-collison",
    now,
    deps: {
      configured: true,
      async plan() {
        return {
          queries: ["Patrick Collison site:theorg.com", "site:linkedin.com Patrick Collison"],
          urls: ["https://example.com/bio", "https://www.linkedin.com/in/patrick-collison"],
          notes: "Public bios only.",
        };
      },
      async search() {
        return { reports: [{ name: "DuckDuckGo", status: "used", detail: "1 result(s)" }], results: [] };
      },
      async wikipedia() {
        return { report: { name: "Wikipedia", status: "used", detail: "0 result(s)" }, results: [] };
      },
      async fetchPage(pageUrl) {
        fetched.push(pageUrl);
        if (pageUrl.startsWith(url)) {
          return {
            url: pageUrl,
            finalUrl: url,
            ok: true,
            title: "Bio",
            text,
            links: [],
            structuredPeople: [],
            error: null,
          };
        }
        return {
          url: pageUrl,
          finalUrl: null,
          ok: false,
          title: "",
          text: "",
          links: [],
          structuredPeople: [],
          error: "skipped",
        };
      },
      async extract() {
        return {
          people: [
            rolePerson("Patrick Collison", "CEO", "Office of the CEO", "2010", null, true, "Patrick Collison is CEO of Stripe since 2010 on the Office of the CEO team."),
            rolePerson("John Collison", "President", "Office of the CEO", "2010", null, true, "John Collison is President of Stripe since 2010 on the Office of the CEO team."),
            rolePerson("Claire Hughes Johnson", "Corporate Officer", null, "2014", "2021", false, "Claire Hughes Johnson was Corporate Officer at Stripe from 2014 to 2021."),
            rolePerson("Priya Nair", null, "Sales", "2016", null, true, "Priya Nair leads Sales at Stripe since 2016."),
            rolePerson("Robin Lee", "Chief Jester", null, null, null, false, "Robin Lee is a designer at Stripe."),
            rolePerson("Ada Lovelace", "Engineer", null, "1999", "2001", false, "Ada Lovelace worked at Stripe from 1999 to 2001."),
          ],
        };
      },
    },
  });

  assert.equal(fetched.some((item) => item.includes("linkedin.com")), false);
  assert.equal(result.subject.name, "Patrick Collison");
  assert.deepEqual(result.currentColleagues.map((person) => person.name), ["John Collison"]);
  assert.equal(result.currentColleagues[0].grouping, "team");
  assert.equal(result.currentColleagues[0].sourceUrl, url);
  assert.deepEqual(result.pastColleagues.map((person) => person.name), ["Claire Hughes Johnson"]);
  assert.equal(result.pastColleagues[0].overlap.start, "2014");
  assert.equal(result.pastColleagues[0].overlap.end, "2021");
  assert.deepEqual(result.unestablished.map((person) => person.name), ["Robin Lee"]);
  assert.equal(result.unestablished[0].title, null);
  assert.equal(JSON.stringify(result).includes("Ada Lovelace"), false);
  assert.ok(result.omitted.quoteNotInSource >= 1);
});

test("asks for a clearer name when two people match", async () => {
  const url = "https://example.com/two";
  const text = "Alex Kim leads Design at Northwind since 2018. Alex Jordan Kim leads Research at Northwind since 2019.";
  const result = await runResearch({
    rawQuery: "Alex Kim",
    now,
    deps: {
      configured: true,
      async plan() { return { queries: ["Alex Kim"], urls: [url] }; },
      async search() { return { reports: [], results: [] }; },
      async wikipedia() { return { report: { name: "Wikipedia", status: "used" }, results: [] }; },
      async fetchPage() {
        return { url, finalUrl: url, ok: true, title: "Two", text, links: [], structuredPeople: [], error: null };
      },
      async extract() {
        return {
          people: [
            rolePerson("Alex Kim", "Design lead", null, "2018", null, true, "Alex Kim leads Design at Northwind since 2018.", "Northwind"),
            rolePerson("Alex Jordan Kim", "Research lead", null, "2019", null, true, "Alex Jordan Kim leads Research at Northwind since 2019.", "Northwind"),
          ],
        };
      },
    },
  });
  assert.equal(result.subject, null);
  assert.equal(result.disambiguation.length, 2);
  assert.equal(result.currentColleagues.length, 0);
});

test("parses model JSON and search results", () => {
  assert.deepEqual(parseModelJson("```json\n{\"queries\":[\"Ada Lovelace\"]}\n```"), { queries: ["Ada Lovelace"] });
  assert.equal(responseText({ output_text: "{\"ok\":true}" }), "{\"ok\":true}");
  assert.equal(
    responseText({ choices: [{ message: { content: "{\"ok\":true}" } }] }),
    "{\"ok\":true}",
  );
  const results = parseDuckDuckGoHtml(`
    <a class="result__a" href="https://duckduckgo.com/l/?uddg=https%3A%2F%2Ftheorg.com%2Forg%2Fstripe&amp;rut=1">Stripe</a>
    <a class="result__a" href="https://duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.linkedin.com%2Fin%2Fsomeone">Skip</a>
  `);
  assert.deepEqual(results.map((result) => result.url), ["https://theorg.com/org/stripe"]);
});

function rolePerson(name, title, team, start, end, current, evidence, company = "Stripe") {
  return {
    name,
    roles: [{
      company,
      title,
      team,
      start,
      end,
      current,
      sourceUrl: evidence.includes("Northwind") ? "https://example.com/two" : "https://example.com/bio",
      evidence,
    }],
  };
}
