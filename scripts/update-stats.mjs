#!/usr/bin/env node
// Refreshes visible PostHog cards and the private-to-the-site Flyweight source
// values. `--render-only` regenerates the review artwork from stats/data.json
// without contacting PostHog or GitHub. `--print-sql` prints the exact queries.

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const STATS_DIR = path.join(ROOT, "stats");
const CARDS_DIR = path.join(STATS_DIR, "cards");
const README = path.join(ROOT, "README.md");
const MARK_START = "<!-- STATS:START -->";
const MARK_END = "<!-- STATS:END -->";
const NOW = new Date();
const TODAY_IST = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" }).format(NOW);
const STALE_AFTER_DAYS = 1;
let notRefreshed = 0;

const ageDays = (date) => Math.floor((Date.parse(`${TODAY_IST}T00:00:00Z`) - Date.parse(`${date}T00:00:00Z`)) / 86_400_000);
const statusFor = (asOf) => (ageDays(asOf) > STALE_AFTER_DAYS ? "snapshot" : "live");
const isMissing = (value) => value === null || value === undefined || value === "";

function githubToken() {
  const env = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  if (env) return env;
  try {
    return execFileSync("gh", ["auth", "token"], { encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}

const ghHeaders = (token) => ({
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28",
  "User-Agent": "mukndd-profile-stats",
  ...(token ? { Authorization: `Bearer ${token}` } : {}),
});

async function repoMeta(repo) {
  const res = await fetch(`https://api.github.com/repos/${repo}`, { headers: ghHeaders(githubToken()) });
  if (!res.ok) throw new Error(`repo HTTP ${res.status}`);
  return res.json();
}

async function resolveFileRegex({ project, source }) {
  const meta = await repoMeta(project.repo);
  const p = source.path.split("/").map(encodeURIComponent).join("/");
  const res = await fetch(`https://api.github.com/repos/${project.repo}/contents/${p}?ref=${encodeURIComponent(meta.default_branch)}`, {
    headers: { ...ghHeaders(githubToken()), Accept: "application/vnd.github.raw+json" },
  });
  if (!res.ok) throw new Error(`file HTTP ${res.status}`);
  const match = (await res.text()).match(new RegExp(source.pattern));
  if (!match) throw new Error("pattern not found");
  const value = Number(match[1].replace(/,/g, ""));
  if (!Number.isFinite(value)) throw new Error("not a number");
  return { value, asOf: TODAY_IST };
}

function sqlString(value) {
  if (typeof value !== "string" || value.includes("\0")) throw new Error("invalid string in stats config");
  return `'${value.replaceAll("'", "''")}'`;
}

function sqlList(values) {
  if (!Array.isArray(values) || values.length === 0) throw new Error("empty list in stats config");
  return values.map(sqlString).join(", ");
}

function selectorSql(selector) {
  if (selector.hosts?.length) return `properties.$host IN (${sqlList(selector.hosts)})`;
  if (!selector.app) throw new Error("stats selector needs hosts or an app");
  const current = `properties.app = ${sqlString(selector.app)}`;
  const legacyHosts = selector.legacyHosts ?? [];
  if (!legacyHosts.length) return current;
  return `(${current} OR (properties.app IS NULL AND properties.$host IN (${sqlList(legacyHosts)})))`;
}

function eventCondition(stat) {
  const clauses = [`event IN (${sqlList(stat.source.events)})`];
  if (stat.source.pathname) clauses.push(`properties.$pathname = ${sqlString(stat.source.pathname)}`);
  if (stat.source.windowDays) {
    if (!Number.isInteger(stat.source.windowDays) || stat.source.windowDays < 1 || stat.source.windowDays > 90) {
      throw new Error("windowDays must be an integer between 1 and 90");
    }
    clauses.push(`timestamp >= now() - INTERVAL ${stat.source.windowDays} DAY`);
  }
  return `(${clauses.join(" AND ")})`;
}

function includedPersonCondition(config) {
  if (!Number.isInteger(config.excludeCohort) || config.excludeCohort < 1) throw new Error("excludeCohort must be a positive integer");
  return [
    `person_id NOT IN COHORT ${config.excludeCohort}`,
    "NOT isLikelyBot(properties.$raw_user_agent)",
  ].join(" AND ");
}

// Count tracked PostHog identities after the internal cohort and PostHog's
// user-agent bot filter. Rows without a usable user agent do not qualify.
function posthogSql(config, project, stat) {
  const matches = eventCondition(stat);
  const included = `(${matches} AND ${includedPersonCondition(config)})`;
  const measure = stat.source.measure ?? "people";
  const value = measure === "countries"
    ? `uniqIf(properties.$geoip_country_code, ${included} AND isNotNull(properties.$geoip_country_code) AND properties.$geoip_country_code != '')`
    : `uniqIf(person_id, ${included})`;
  if (!["people", "countries"].includes(measure)) throw new Error(`unsupported PostHog measure: ${measure}`);
  return [
    "SELECT",
    `  ${value} AS value,`,
    `  maxIf(timestamp, ${included}) AS latest_included_event_at,`,
    `  countIf(${matches}) AS matching_event_rows,`,
    "  count() AS selected_site_event_rows,",
    "  max(timestamp) AS latest_selected_site_event_at",
    "FROM events",
    `WHERE timestamp >= toDateTime('${config.since} 00:00:00')`,
    `  AND ${selectorSql(project.selector)}`,
  ].join("\n");
}

function auditSql(config, project) {
  return [
    "SELECT",
    "  count() AS selected_site_event_rows,",
    "  max(timestamp) AS latest_observed_event_at",
    "FROM events",
    `WHERE timestamp >= toDateTime('${config.since} 00:00:00')`,
    `  AND ${selectorSql(project.selector)}`,
  ].join("\n");
}

async function posthogQuery(config, query) {
  const key = process.env.POSTHOG_API_KEY;
  const projectId = config.projectId;
  if (!key) throw new Error("POSTHOG_API_KEY not set");
  if (!Number.isInteger(projectId) || projectId < 1) throw new Error("PostHog projectId not set or invalid");
  const response = await fetch(`${config.host}/api/projects/${projectId}/query/`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query: { kind: "HogQLQuery", query }, name: "profile-stats" }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`PostHog HTTP ${response.status}`);
  const body = await response.json();
  const row = body.results?.[0];
  if (!Array.isArray(row)) throw new Error("unexpected query response shape");
  return row;
}

async function resolvePosthog({ config, project, stat }) {
  const [value, latestIncludedEventAt, matchingEventRows, selectedSiteEventRows, latestSelectedSiteEventAt] = await posthogQuery(config, posthogSql(config, project, stat));
  const queryRefreshedAt = new Date().toISOString();
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new Error("invalid metric value");
  if (typeof matchingEventRows !== "number" || typeof selectedSiteEventRows !== "number") throw new Error("missing query validation counts");
  if (selectedSiteEventRows === 0) return { noEvents: true, value, matchingEventRows, selectedSiteEventRows, queryRefreshedAt };
  if (!isMissing(latestIncludedEventAt) && !Number.isFinite(Date.parse(latestIncludedEventAt))) throw new Error("invalid latest included event timestamp");
  if (!Number.isFinite(Date.parse(latestSelectedSiteEventAt))) throw new Error("invalid latest selected-site event timestamp");
  // A zero value remains valid. matchingEventRows is kept for review/debugging;
  // no matched metric events can mean a valid zero, while an empty site selector
  // is the detectable schema/filter mismatch above.
  return {
    value,
    latestIncludedEventAt: isMissing(latestIncludedEventAt) || Date.parse(latestIncludedEventAt) === 0 ? null : latestIncludedEventAt,
    matchingEventRows,
    selectedSiteEventRows,
    latestSelectedSiteEventAt,
    queryRefreshedAt,
  };
}

async function resolveAudit({ config, project }) {
  const [selectedSiteEventRows, latestObservedEventAt] = await posthogQuery(config, auditSql(config, project));
  const queryRefreshedAt = new Date().toISOString();
  if (typeof selectedSiteEventRows !== "number" || isMissing(latestObservedEventAt)) throw new Error("site audit returned no events; check app selector schema");
  if (!Number.isFinite(Date.parse(latestObservedEventAt))) throw new Error("invalid latest observed event timestamp");
  return { latestObservedEventAt, queryRefreshedAt };
}

const RESOLVERS = { posthog: resolvePosthog, "file-regex": resolveFileRegex };

async function readJson(file, fallback) {
  try { return JSON.parse(await readFile(file, "utf8")); } catch { return fallback; }
}

function dateInIST(timestamp) {
  if (!timestamp) return TODAY_IST;
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(timestamp));
}

async function collect(config) {
  const previous = await readJson(path.join(STATS_DIR, "data.json"), { projects: {} });
  const out = { generatedAt: NOW.toISOString(), projects: { ...(previous.projects ?? {}) } };

  for (const project of config.projects) {
    const prior = previous.projects?.[project.id] ?? { stats: {} };
    const entry = {
      name: project.name,
      url: project.url,
      window: project.window ?? "All time",
      stats: {},
    };

    if (project.reportable === false) {
      try {
        const resolved = await resolveAudit({ config: config.posthog, project });
        entry.trackingStatus = "notTrackedYet";
        entry.notTrackedReason = project.notTrackedReason;
        entry.queryRefreshedAt = resolved.queryRefreshedAt;
        entry.latestObservedEventAt = resolved.latestObservedEventAt;
      } catch (error) {
        notRefreshed++;
        console.warn(`${project.id}: quality check not refreshed (${error.message})`);
        entry.trackingStatus = "notTrackedYet";
        entry.notTrackedReason = project.notTrackedReason;
        entry.queryRefreshedAt = prior.queryRefreshedAt ?? null;
        entry.latestObservedEventAt = prior.latestObservedEventAt ?? null;
      }
      out.projects[project.id] = entry;
      continue;
    }

    const results = [];
    let noSiteEvents = false;
    for (const stat of project.stats) {
      const last = prior.stats?.[stat.id];
      let resolved = null;
      try {
        resolved = await RESOLVERS[stat.source.type]({ config: config.posthog, project, stat });
      } catch (error) {
        notRefreshed++;
        console.warn(`${project.id}.${stat.id}: not refreshed (${error.message})`);
      }
      if (resolved?.noEvents) {
        entry.trackingStatus = "notTrackedYet";
        entry.notTrackedReason = `Tracking is not live yet. No PostHog events were found on ${project.selector.hosts.join(", ")} since ${config.posthog.since}.`;
        entry.queryRefreshedAt = resolved.queryRefreshedAt;
        entry.observedEventRows = 0;
        entry.latestObservedEventAt = null;
        noSiteEvents = true;
        break;
      }
      const base = { label: stat.label, definition: stat.definition, cardDefinition: stat.cardDefinition, source: stat.source.type };
      if (resolved) {
        const asOf = dateInIST(resolved.queryRefreshedAt);
        entry.stats[stat.id] = {
          ...base,
          value: resolved.value,
          status: "live",
          verified: true,
          asOf,
          matchingEventRows: resolved.matchingEventRows,
          latestIncludedEventAt: resolved.latestIncludedEventAt,
          queryRefreshedAt: resolved.queryRefreshedAt,
        };
        results.push({
          ok: true,
          queryRefreshedAt: resolved.queryRefreshedAt,
          latest: resolved.latestIncludedEventAt,
          selectedSiteEventRows: resolved.selectedSiteEventRows,
          latestObserved: resolved.latestSelectedSiteEventAt,
        });
      } else if (last && typeof last.value === "number" && last.asOf) {
        entry.stats[stat.id] = {
          ...base,
          value: last.value,
          status: statusFor(last.asOf),
          verified: last.verified === true,
          asOf: last.asOf,
          matchingEventRows: last.matchingEventRows ?? null,
          latestIncludedEventAt: last.latestIncludedEventAt ?? null,
          queryRefreshedAt: last.queryRefreshedAt ?? prior.queryRefreshedAt ?? null,
        };
        results.push({ ok: false, queryRefreshedAt: last.queryRefreshedAt ?? prior.queryRefreshedAt ?? null, latest: last.latestIncludedEventAt ?? null });
      } else {
        throw new Error(`${project.id}.${stat.id}: no value and no prior snapshot`);
      }
    }
    if (noSiteEvents) {
      out.projects[project.id] = entry;
      continue;
    }
    entry.trackingStatus = "tracked";
    const allRefreshed = results.every((result) => result.ok);
    entry.queryRefreshedAt = allRefreshed
      ? results.map((result) => result.queryRefreshedAt).filter(Boolean).sort().at(-1)
      : prior.queryRefreshedAt ?? null;
    entry.latestIncludedEventAt = results.map((result) => result.latest).filter(Boolean).sort().at(-1) ?? null;
    entry.observedEventRows = results.map((result) => result.selectedSiteEventRows).filter(Number.isFinite).at(-1) ?? prior.observedEventRows ?? null;
    entry.latestObservedEventAt = results.map((result) => result.latestObserved).filter(Boolean).sort().at(-1) ?? prior.latestObservedEventAt ?? null;
    out.projects[project.id] = entry;
  }

  for (const project of config.dataOnlyProjects ?? []) {
    const prior = previous.projects?.[project.id] ?? { stats: {} };
    const entry = {
      name: project.name,
      url: project.url,
      live: project.live,
      pushedAt: prior.pushedAt ?? null,
      stats: {},
    };
    try {
      entry.pushedAt = (await repoMeta(project.repo)).pushed_at?.slice(0, 10) ?? entry.pushedAt;
    } catch { /* keep prior public-repository metadata */ }
    for (const stat of project.stats) {
      let resolved = null;
      try { resolved = await RESOLVERS[stat.source.type]({ project, stat }); }
      catch (error) {
        notRefreshed++;
        console.warn(`${project.id}.${stat.id}: not refreshed (${error.message})`);
      }
      const last = prior.stats?.[stat.id];
      if (resolved) entry.stats[stat.id] = { label: stat.label, ...(stat.sub && { sub: stat.sub }), ...(stat.suffix && { suffix: stat.suffix }), source: stat.source.type, value: resolved.value, status: "live", asOf: resolved.asOf };
      else if (last) entry.stats[stat.id] = { ...last, status: statusFor(last.asOf) };
      else throw new Error(`${project.id}.${stat.id}: no value and no prior snapshot`);
    }
    out.projects[project.id] = entry;
  }

  return out;
}

const esc = (value) => String(value).replace(/[&<>\"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;" })[char]);
const display = (stat) => new Intl.NumberFormat("en-US").format(stat.value) + (stat.suffix ?? "");

function fmtIST(timestamp) {
  if (!timestamp) return "not available";
  const formatted = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kolkata", day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).format(new Date(timestamp));
  return `${formatted} IST`;
}

function fmtAsOf(date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date ?? "")) return "unknown";
  return new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", day: "2-digit", month: "short", year: "numeric" }).format(new Date(`${date}T00:00:00Z`));
}

function wrapText(text, maxChars) {
  const lines = [];
  let line = "";
  for (const word of String(text ?? "").split(/\s+/)) {
    const next = line ? `${line} ${word}` : word;
    if (line && next.length > maxChars) { lines.push(line); line = word; }
    else line = next;
  }
  if (line) lines.push(line);
  return lines;
}

function svgTextLines(text, x, y, maxChars, lineHeight, fontSize, color, anchor = "start") {
  return `<text x="${x}" y="${y}" text-anchor="${anchor}" font-size="${fontSize}" fill="${color}">${wrapText(text, maxChars).map((line, index) => `<tspan x="${x}" dy="${index ? lineHeight : 0}">${esc(line)}</tspan>`).join("")}</text>`;
}

function cardContents(project, mobile = false) {
  const width = mobile ? 390 : 580;
  const height = mobile ? 440 : 310;
  const stats = Object.values(project.stats ?? {});
  const tracked = project.trackingStatus === "tracked" && stats.length > 0;
  const title = esc(project.name);
  const stamp = project.queryRefreshedAt ? fmtIST(project.queryRefreshedAt) : "not yet queried";
  const asOf = stats.find((stat) => stat.asOf)?.asOf;
  const statusDot = stats.some((stat) => stat.status !== "live") ? "#8B949E" : "#3FB950";
  const out = [
    `<rect x="0.5" y="0.5" width="${width - 1}" height="${height - 1}" rx="14" fill="#0D1117" stroke="#30363D"/>`,
    `<rect x="24" y="0" width="40" height="3" rx="1.5" fill="#A78BFA"/>`,
    `<text x="24" y="36" font-size="${mobile ? 18 : 20}" font-weight="600" fill="#E6EDF3">${title}</text>`,
    ...(asOf ? [`<text x="${width - 24}" y="35" text-anchor="end" font-size="${mobile ? 10.5 : 11.5}" fill="#8B949E">As of ${esc(fmtAsOf(asOf))} IST</text>`] : []),
    `<line x1="24" y1="52" x2="${width - 24}" y2="52" stroke="#30363D"/>`,
  ];

  if (!tracked) {
    out.push(`<text x="${width / 2}" y="${mobile ? 144 : 145}" text-anchor="middle" font-size="${mobile ? 23 : 26}" font-weight="600" fill="#E6EDF3">Tracking not live yet</text>`);
    out.push(svgTextLines(project.notTrackedReason ?? "No matching PostHog events have been observed yet.", width / 2, mobile ? 177 : 178, mobile ? 40 : 62, 17, mobile ? 12.5 : 14, "#8B949E", "middle"));
    out.push(`<text x="24" y="${mobile ? 360 : 245}" font-size="11" fill="#8B949E">No visitor or country total reported</text>`);
  } else {
    const positions = mobile
      ? [[30, 91], [202, 91], [30, 211], [202, 211]]
      : [[26, 94], [306, 94], [26, 174], [306, 174]];
    stats.slice(0, 4).forEach((stat, index) => {
      const [x, top] = positions[index];
      const definition = stat.cardDefinition ?? stat.definition ?? stat.sub ?? "";
      const lineHeight = mobile ? 13 : 14;
      const maxChars = mobile ? 24 : 33;
      out.push(`<text x="${x}" y="${top}" font-size="${mobile ? 30 : 33}" font-weight="650" fill="#E6EDF3">${esc(display(stat))}</text>`);
      out.push(`<text x="${x}" y="${top + 22}" font-size="${mobile ? 13.5 : 15}" font-weight="600" fill="#C9D1D9">${esc(stat.label)}</text>`);
      out.push(svgTextLines(definition, x, top + 40, maxChars, lineHeight, mobile ? 11 : 12, "#8B949E"));
    });
    out.push(`<circle cx="28" cy="${mobile ? 337 : 255}" r="3.5" fill="${statusDot}"/>`);
    out.push(`<text x="38" y="${mobile ? 341 : 259}" font-size="${mobile ? 10.5 : 11.5}" fill="#8B949E">${esc(project.window ?? "Since 25 Aug 2026")}</text>`);
    out.push(`<text x="24" y="${mobile ? 373 : 282}" font-size="${mobile ? 10.5 : 11}" fill="#C9D1D9">Tracked identities · bots and my test accounts excluded</text>`);
    out.push(`<text x="24" y="${mobile ? 414 : 301}" font-size="${mobile ? 10 : 10.5}" fill="#8B949E">Query refreshed: ${esc(stamp)}</text>`);
  }

  if (!tracked) out.push(`<text x="24" y="${mobile ? 412 : 295}" font-size="${mobile ? 10 : 10.5}" fill="#6E7681">PostHog check refreshed · ${esc(stamp)}</text>`);
  return `<g>${out.join("")}</g>`;
}

function renderCardSvg(project) {
  const width = 580, height = 310;
  const alt = project.trackingStatus === "tracked"
    ? `${project.name}: ${Object.values(project.stats).map((stat) => `${display(stat)} ${stat.label}; ${stat.definition}; metric as of ${stat.asOf} IST`).join(". ")}. ${project.window}. Tracked identities; bots and internal test accounts excluded. Query refreshed ${fmtIST(project.queryRefreshedAt)}.`
    : `${project.name}: tracking not live yet. No visitor or country total reported. ${project.notTrackedReason ?? ""} ${project.window}. PostHog check refreshed ${fmtIST(project.queryRefreshedAt)}.`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(alt)}" font-family="-apple-system,'Segoe UI',Helvetica,Arial,sans-serif"><title>${esc(alt)}</title>${cardContents(project)}</svg>\n`;
}

function renderBoard(projects, mobile = false) {
  const width = mobile ? 390 : 1200;
  const cardWidth = mobile ? 390 : 580;
  const cardHeight = mobile ? 440 : 310;
  const gap = mobile ? 16 : 20;
  const margin = mobile ? 0 : 10;
  const columns = mobile ? 1 : 2;
  const rows = Math.ceil(projects.length / columns);
  const height = margin * 2 + rows * cardHeight + (rows - 1) * gap;
  const groups = projects.map((project, index) => {
    const x = margin + (index % columns) * (cardWidth + gap);
    const y = margin + Math.floor(index / columns) * (cardHeight + gap);
    return `<g transform="translate(${x} ${y})">${cardContents(project, mobile)}</g>`;
  }).join("");
  const alt = projects.map((project) => project.name + (project.trackingStatus === "tracked" ? `: ${Object.values(project.stats).map((stat) => `${display(stat)} ${stat.label}; ${stat.definition}; metric as of ${stat.asOf} IST; latest included event ${fmtIST(stat.latestIncludedEventAt)}`).join(". ")}. Last complete query refresh ${fmtIST(project.queryRefreshedAt)}.` : ": not tracked yet, no visitor total reported")).join("; ");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(alt)}" font-family="-apple-system,'Segoe UI',Helvetica,Arial,sans-serif"><title>${esc(alt)}</title>${groups}</svg>\n`;
}

function renderReadmeBlock(data, visibleProjects) {
  const sourceLinks = visibleProjects.map((project) => `<a href="${esc(project.url)}">${esc(project.name)}</a>`).join(" · ");
  const caption = `Counts are unique tracked PostHog <code>person_id</code> values. The bot filter and my internal test cohort are excluded; events without a usable user agent do not qualify. All-time numbers cover events since 25 Aug 2026. “This week” is a rolling 7-day count of qualifying page views. Portfolio uses the PostHog <code>$pageview</code> event emitted by mukndd.com; resume views appear only because <code>resume_viewed</code> is present there. Asterisms engagement uses the verified game and sky-action event list. Metric dates and query times are shown in IST. These tracked identities are not a claim of personhood. Sources: PostHog and <a href="stats/data.json">stats/data.json</a>. ${sourceLinks}.`;
  const alt = visibleProjects.map((project) => project.trackingStatus === "tracked"
    ? `${project.name}: ${Object.values(project.stats).map((stat) => `${display(stat)} ${stat.label}; ${stat.definition}; metric as of ${stat.asOf} IST`).join(". ")}. Query refreshed ${fmtIST(project.queryRefreshedAt)}`
    : `${project.name}: Tracking not live yet; no visitor or country total reported`).join(". ");
  return `${MARK_START}\n<p align="center">\n  <picture>\n    <source media="(max-width: 600px)" srcset="stats/cards/mobile.svg" />\n    <img src="stats/cards/desktop.svg" width="100%" alt="${esc(alt)}" />\n  </picture>\n</p>\n<p><sub>${caption}</sub></p>\n${MARK_END}`;
}

async function writeIfChanged(file, content) {
  const existing = existsSync(file) ? await readFile(file, "utf8") : null;
  if (existing === content) return;
  await writeFile(file, content);
}

async function render(data, config) {
  await mkdir(CARDS_DIR, { recursive: true });
  const visible = config.projects.map((project) => data.projects[project.id]).filter(Boolean);
  for (const project of visible) await writeIfChanged(path.join(CARDS_DIR, `${project.name.toLowerCase()}.svg`), renderCardSvg(project));
  await writeIfChanged(path.join(CARDS_DIR, "desktop.svg"), renderBoard(visible));
  await writeIfChanged(path.join(CARDS_DIR, "mobile.svg"), renderBoard(visible, true));

  const readme = await readFile(README, "utf8");
  const start = readme.indexOf(MARK_START), end = readme.indexOf(MARK_END);
  if (start === -1 || end === -1 || end < start) throw new Error("README.md is missing the STATS markers");
  await writeIfChanged(README, readme.slice(0, start) + renderReadmeBlock(data, visible) + readme.slice(end + MARK_END.length));
}

const config = await readJson(path.join(STATS_DIR, "projects.json"), null);
if (!config) throw new Error("stats/projects.json missing");

if (process.argv.includes("--print-sql")) {
  for (const project of config.projects) {
    if (project.reportable === false) console.log(`-- ${project.id} quality audit\n${auditSql(config.posthog, project)}\n`);
    else for (const stat of project.stats) console.log(`-- ${project.id}.${stat.id}\n${posthogSql(config.posthog, project, stat)}\n`);
  }
  process.exit(0);
}

if (process.argv.includes("--render-only")) {
  const data = await readJson(path.join(STATS_DIR, "data.json"), null);
  if (!data?.projects) throw new Error("stats/data.json is missing projects");
  await render(data, config);
  console.log("rendered cards and README block from local data; no API calls made");
  process.exit(0);
}

const data = await collect(config);
await writeIfChanged(path.join(STATS_DIR, "data.json"), `${JSON.stringify(data, null, 2)}\n`);
await render(data, config);
console.log("done");

// Queries and quality audits fail loudly, including when credentials are absent.
// Previously saved values remain visible as dated snapshots while the Action is red.
if (notRefreshed) {
  console.error(`${notRefreshed} stat(s) or data-quality check(s) were not refreshed`);
  process.exitCode = 1;
}
