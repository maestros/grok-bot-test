const main = document.querySelector("#main");
const account = document.querySelector("#account");

const ERRORS = {
  linkedin_config: "LinkedIn sign-in is not configured on this server.",
  linkedin_denied: "LinkedIn sign-in was cancelled.",
  linkedin_state: "The LinkedIn sign-in session expired. Try again.",
  linkedin_token: "LinkedIn did not complete sign-in. Check the app's OpenID Connect product and redirect URL.",
};

const STEPS = {
  planning: "Planning public searches",
  searching: "Searching public pages",
  reading: "Reading sources",
  extracting: "Extracting facts",
  verifying: "Checking every fact against the fetched page",
  done: "Done",
};

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

let session = { authenticated: false };

boot();

async function boot() {
  const params = new URLSearchParams(location.search);
  const error = ERRORS[params.get("error")] || "";
  if (error) history.replaceState({}, "", "/");
  session = await getJson("/api/session");
  renderAccount();
  renderMain(error);
}

function renderAccount() {
  if (!session.authenticated) {
    account.innerHTML = "";
    return;
  }
  account.innerHTML = `
    <div class="account-row">
      <span>${esc(session.user.name)}</span>
      <button class="secondary" id="logout" type="button">Sign out</button>
    </div>`;
  document.querySelector("#logout").addEventListener("click", logout);
}

function renderMain(error) {
  if (!session.authenticated) {
    main.innerHTML = `
      ${error ? `<div class="banner error">${esc(error)}</div>` : ""}
      <h1>Who shared the team?</h1>
      <p class="lede">Sign in with LinkedIn, then enter a name or a public profile URL. The lookup reads public pages and keeps a colleague only when a fetched source supports the fact.</p>
      <p><a class="button" href="/auth/linkedin">Sign in with LinkedIn</a></p>`;
    return;
  }
  main.innerHTML = `
    ${error ? `<div class="banner error">${esc(error)}</div>` : ""}
    <h1>Look up a person</h1>
    <p class="lede">Use a name, or a public URL like https://www.linkedin.com/in/name. The profile page itself is not opened.</p>
    ${session.researchReady ? "" : `<div class="banner">XAI_API_KEY is not set, so lookups cannot run yet.</div>`}
    <form class="panel" id="lookup">
      <label for="query">Name or public LinkedIn profile URL</label>
      <input id="query" name="query" type="text" maxlength="300" required autocomplete="off" placeholder="Ada Lovelace or https://www.linkedin.com/in/ada-lovelace">
      <div class="actions">
        <button type="submit">Find colleagues</button>
      </div>
      <p class="status" id="status" aria-live="polite"></p>
    </form>
    <div id="results"></div>`;
  document.querySelector("#lookup").addEventListener("submit", onSubmit);
}

async function onSubmit(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector("button");
  const status = document.querySelector("#status");
  const results = document.querySelector("#results");
  const query = new FormData(form).get("query");
  button.disabled = true;
  results.innerHTML = "";
  status.textContent = "Starting the lookup";
  try {
    const created = await postJson("/api/research", { query });
    const job = await pollJob(created.id, status);
    if (job.status === "error") {
      status.textContent = "";
      results.innerHTML = `<div class="banner error">${esc(job.error?.message || "The lookup failed.")}</div>`;
      return;
    }
    status.textContent = "";
    results.innerHTML = renderResult(job.result);
  } catch (error) {
    status.textContent = "";
    results.innerHTML = `<div class="banner error">${esc(error.message)}</div>`;
  } finally {
    button.disabled = false;
  }
}

async function pollJob(id, status) {
  const started = Date.now();
  while (Date.now() - started < 180000) {
    const job = await getJson(`/api/research/${id}`);
    status.textContent = STEPS[job.step] || "Working";
    if (job.status === "done" || job.status === "error") return job;
    await wait(1200);
  }
  throw new Error("The lookup took too long. Try again.");
}

function renderResult(result) {
  const notes = (result.notes || []).map((note) => `<li>${esc(note)}</li>`).join("");
  const omitted = Object.values(result.omitted || {}).reduce((sum, count) => sum + count, 0);
  return `
    <section class="section">
      <h2>${esc(result.subject?.name || result.query.name)}</h2>
      ${result.query.kind === "linkedin_url" ? `<p class="note">Searched public pages for this name. The LinkedIn URL was not opened.</p>` : ""}
      ${result.disambiguation?.length ? renderDisambiguation(result.disambiguation) : ""}
      ${result.subject ? renderRoles(result.subject.roles) : `<div class="empty">No employer could be verified from the pages that were read.</div>`}
    </section>
    ${renderGroup("Current colleagues", result.currentColleagues, "No current colleague has a verified shared window.")}
    ${renderGroup("Past colleagues", result.pastColleagues, "No past colleague has a verified shared window.")}
    ${renderGroup("Overlap not established", result.unestablished, "No same-organization listing was left without a date range.")}
    <section class="section">
      <h2>Sources</h2>
      ${notes ? `<ul class="plain">${notes}</ul>` : ""}
      ${omitted ? `<p class="note">${omitted} unsupported claim${omitted === 1 ? " was" : "s were"} dropped.</p>` : ""}
      <ul class="plain">${(result.sources || []).map(renderSource).join("") || "<li>No pages were fetched.</li>"}</ul>
      ${renderSearch(result.search)}
    </section>`;
}

function renderDisambiguation(people) {
  return `<div class="banner">More than one person matched. Enter a more specific name. ${people.map((person) => esc(person.name)).join(", ")}</div>`;
}

function renderRoles(roles) {
  if (!roles?.length) return `<div class="empty">No employer could be verified from the pages that were read.</div>`;
  return `<div class="stack">${roles.map((role) => `
    <article class="card">
      <header><h3>${esc(role.title || "Role title not stated")}</h3><span class="tag">${esc(role.company)}</span></header>
      <dl>
        <dt>Team</dt><dd>${esc(role.team || "Not published")}</dd>
        <dt>Dates</dt><dd>${esc(dateSpan(role))}</dd>
      </dl>
      ${renderEvidence(role.evidence, role.sourceUrl)}
    </article>`).join("")}</div>`;
}

function renderGroup(title, people, empty) {
  const cards = (people || []).map(renderColleague).join("");
  return `<section class="section"><h2>${esc(title)}</h2>${cards ? `<div class="stack">${cards}</div>` : `<div class="empty">${esc(empty)}</div>`}</section>`;
}

function renderColleague(person) {
  const overlap = person.overlap || {};
  const windowText = overlap.start || overlap.end
    ? `${formatWhen(overlap.start) || "start not published"} – ${overlap.end ? formatWhen(overlap.end) : "present"}`
    : "No dated window";
  const grouping = person.grouping === "team"
    ? `Same team: ${person.groupingLabel}`
    : `Closest public grouping is the company. A shared team was not published.`;
  return `
    <article class="card">
      <header><h3>${esc(person.name)}</h3><span class="tag">${esc(person.company)}</span></header>
      <p>${esc(person.title || "Title not stated in the source")}</p>
      <dl>
        <dt>Overlap</dt><dd>${esc(windowText)}</dd>
        <dt>Grouping</dt><dd>${esc(grouping)}</dd>
      </dl>
      <p class="note">${esc(overlap.note || "")}</p>
      ${renderEvidence(person.evidence, person.sourceUrl)}
    </article>`;
}

function renderEvidence(evidence, sourceUrl) {
  const href = safeUrl(sourceUrl);
  return `
    ${evidence ? `<blockquote>${esc(evidence)}</blockquote>` : ""}
    ${href ? `<p><a class="source" href="${esc(href)}" rel="noreferrer" target="_blank">Source</a></p>` : ""}`;
}

function renderSource(source) {
  const href = safeUrl(source.url);
  const label = source.title || source.url;
  const body = href ? `<a class="source" href="${esc(href)}" rel="noreferrer" target="_blank">${esc(label)}</a>` : esc(label);
  return `<li>${body}${source.ok ? "" : ` — ${esc(source.error || "not read")}`}</li>`;
}

function renderSearch(search) {
  if (!search?.length) return "";
  return `<p class="note">Search: ${search.map((item) => `${esc(item.name)} (${esc(item.status)})`).join(", ")}</p>`;
}

function dateSpan(role) {
  if (!role.start && !role.end && role.current) return "Listed as current. Start date not published.";
  if (!role.start && !role.end) return "Dates not published";
  return `${formatWhen(role.start) || "start not published"} – ${role.end ? formatWhen(role.end) : role.current ? "present" : "end not published"}`;
}

function formatWhen(value) {
  if (!value) return "";
  const match = /^(\d{4})-(\d{2})$/.exec(value);
  if (!match) return value;
  return `${MONTHS[Number(match[2]) - 1]} ${match[1]}`;
}

async function logout() {
  await postJson("/auth/logout", {});
  session = { authenticated: false };
  renderAccount();
  renderMain("");
}

async function getJson(url) {
  const response = await fetch(url, { headers: { Accept: "application/json" } });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || "The request failed.");
  return payload;
}

async function postJson(url, body) {
  const headers = { Accept: "application/json", "Content-Type": "application/json" };
  if (session.csrfToken) headers["X-CSRF-Token"] = session.csrfToken;
  const response = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || "The request failed.");
  return payload;
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[char]));
}

function safeUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") return "";
    return url.href;
  } catch {
    return "";
  }
}
