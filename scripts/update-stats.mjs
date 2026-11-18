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

async function resolveFileRegex({ project, stat }) {
  const { source } = stat;
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
    "(isNull(properties.$raw_user_agent) OR properties.$raw_user_agent = '' OR NOT isLikelyBot(properties.$raw_user_agent))",
  ].join(" AND ");
}

// Count tracked PostHog identities after the internal cohort and PostHog's
// user-agent bot filter. A missing user agent is unknown, not evidence of a bot.
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
    `  countIf(${included}) AS qualifying_event_rows,`,
    `  countIf(${matches} AND isLikelyBot(properties.$raw_user_agent)) AS likely_bot_event_rows,`,
    `  countIf(${matches} AND properties.$virt_is_bot = true) AS virtual_bot_event_rows,`,
    `  countIf(${matches} AND (isNull(properties.$raw_user_agent) OR properties.$raw_user_agent = '')) AS missing_user_agent_event_rows,`,
    `  countIf(${matches} AND person_id IN COHORT ${config.excludeCohort}) AS excluded_cohort_event_rows,`,
    `  countIf(${matches} AND isNull(person_id)) AS missing_person_id_event_rows,`,
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
  const [
    value,
    latestIncludedEventAt,
    matchingEventRows,
    qualifyingEventRows,
    likelyBotEventRows,
    virtualBotEventRows,
    missingUserAgentEventRows,
    excludedCohortEventRows,
    missingPersonIdEventRows,
    selectedSiteEventRows,
    latestSelectedSiteEventAt,
  ] = await posthogQuery(config, posthogSql(config, project, stat));
  const queryRefreshedAt = new Date().toISOString();
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new Error("invalid metric value");
  const validationCounts = [matchingEventRows, qualifyingEventRows, likelyBotEventRows, virtualBotEventRows, missingUserAgentEventRows, excludedCohortEventRows, missingPersonIdEventRows, selectedSiteEventRows];
  if (validationCounts.some((count) => typeof count !== "number")) throw new Error("missing query validation counts");
  if (selectedSiteEventRows === 0) return { noEvents: true, value, matchingEventRows, selectedSiteEventRows, queryRefreshedAt };
  if (!isMissing(latestIncludedEventAt) && !Number.isFinite(Date.parse(latestIncludedEventAt))) throw new Error("invalid latest included event timestamp");
  if (!Number.isFinite(Date.parse(latestSelectedSiteEventAt))) throw new Error("invalid latest selected-site event timestamp");
  const latestSelectedMs = Date.parse(latestSelectedSiteEventAt);
  const staleWindow = stat.source.windowDays
    && matchingEventRows === 0
    && latestSelectedMs < Date.now() - stat.source.windowDays * 86_400_000;
  let unavailableReason = null;
  if (matchingEventRows > 0 && qualifyingEventRows === 0) {
    if (virtualBotEventRows === matchingEventRows && missingUserAgentEventRows === matchingEventRows) {
      unavailableReason = "Every matching event is marked as a virtual bot and has no raw user-agent.";
    } else if (likelyBotEventRows === matchingEventRows) {
      unavailableReason = "Every matching event is excluded by the likely-bot filter.";
    } else if (excludedCohortEventRows === matchingEventRows) {
      unavailableReason = "Every matching event belongs to the excluded test cohort.";
    } else if (missingPersonIdEventRows === matchingEventRows) {
      unavailableReason = "Every matching event is missing person_id.";
    } else {
      unavailableReason = "Matching events are present, but none pass the identity, test-cohort and bot filters.";
    }
  } else if (staleWindow) {
    unavailableReason = `No matching events were observed in the rolling ${stat.source.windowDays}-day window, and the latest site event is outside that window.`;
  }
  const status = unavailableReason
    ? "unavailable"
    : latestIncludedEventAt && Date.now() - Date.parse(latestIncludedEventAt) > 7 * 86_400_000
      ? "snapshot"
      : "live";
  return {
    value: status === "unavailable" ? null : value,
    status,
    unavailableReason,
    latestIncludedEventAt: isMissing(latestIncludedEventAt) || Date.parse(latestIncludedEventAt) === 0 ? null : latestIncludedEventAt,
    matchingEventRows,
    qualifyingEventRows,
    likelyBotEventRows,
    virtualBotEventRows,
    missingUserAgentEventRows,
    excludedCohortEventRows,
    missingPersonIdEventRows,
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
          status: resolved.status,
          verified: resolved.status !== "unavailable",
          asOf,
          matchingEventRows: resolved.matchingEventRows,
          qualifyingEventRows: resolved.qualifyingEventRows,
          likelyBotEventRows: resolved.likelyBotEventRows,
          virtualBotEventRows: resolved.virtualBotEventRows,
          missingUserAgentEventRows: resolved.missingUserAgentEventRows,
          excludedCohortEventRows: resolved.excludedCohortEventRows,
          missingPersonIdEventRows: resolved.missingPersonIdEventRows,
          ...(resolved.unavailableReason ? { unavailableReason: resolved.unavailableReason } : {}),
          latestIncludedEventAt: resolved.latestIncludedEventAt,
          latestObservedEventAt: resolved.latestSelectedSiteEventAt,
          queryRefreshedAt: resolved.queryRefreshedAt,
        };
        results.push({
          ok: true,
          status: resolved.status,
          queryRefreshedAt: resolved.queryRefreshedAt,
          latest: resolved.latestIncludedEventAt,
          selectedSiteEventRows: resolved.selectedSiteEventRows,
          latestObserved: resolved.latestSelectedSiteEventAt,
        });
      } else if (last && (typeof last.value === "number" || last.status === "unavailable") && last.asOf) {
        entry.stats[stat.id] = {
          ...last,
          ...base,
          status: last.status === "unavailable" || last.status === "snapshot" ? last.status : statusFor(last.asOf),
          verified: last.verified === true,
          queryRefreshedAt: last.queryRefreshedAt ?? prior.queryRefreshedAt ?? null,
        };
        results.push({ ok: false, status: entry.stats[stat.id].status, queryRefreshedAt: last.queryRefreshedAt ?? prior.queryRefreshedAt ?? null, latest: last.latestIncludedEventAt ?? null });
      } else {
        throw new Error(`${project.id}.${stat.id}: no value and no prior snapshot`);
      }
    }
    if (noSiteEvents) {
      out.projects[project.id] = entry;
      continue;
    }
    const refreshedStats = Object.values(entry.stats);
    if (refreshedStats.length > 0 && refreshedStats.every((item) => item.status === "unavailable")) {
      const reasons = [...new Set(refreshedStats.map((item) => item.unavailableReason).filter(Boolean))];
      entry.dataQualityNote = reasons.length === 1
        ? reasons[0]
        : "Events were observed, but none produced a current qualifying identity or country total.";
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
const display = (stat) => stat.status === "unavailable"
  ? "—"
  : new Intl.NumberFormat("en-US").format(stat.value) + (stat.suffix ?? "");

const CARD_WIDTH = 390;
const CARD_HEIGHT = 210;
const BOARD_GAP = 12;

function cardContents(project) {
  const width = CARD_WIDTH;
  const height = CARD_HEIGHT;
  const availableStats = Object.entries(project.stats ?? {})
    .filter(([, stat]) => stat.status !== "unavailable" && typeof stat.value === "number" && Number.isFinite(stat.value))
    .map(([id, stat]) => ({ ...stat, id }));
  const hasQualifyingCounts = availableStats.some((stat) => stat.value > 0);
  const title = esc(project.name);
  const out = [
    `<rect x="0.5" y="0.5" width="${width - 1}" height="${height - 1}" rx="14" fill="#0D1117" stroke="#30363D"/>`,
    `<rect x="24" y="0" width="40" height="3" rx="1.5" fill="#A78BFA"/>`,
    `<text x="24" y="36" font-size="18" font-weight="600" fill="#E6EDF3">${title}</text>`,
    `<line x1="24" y1="52" x2="${width - 24}" y2="52" stroke="#30363D"/>`,
  ];

  if (!hasQualifyingCounts) {
    out.push(`<text x="24" y="119" font-size="13" fill="#9AA7B5">No qualifying counts yet</text>`);
  } else {
    const positions = [[28, 94], [214, 94], [28, 164], [214, 164]];
    availableStats.slice(0, 4).forEach((stat, index) => {
      const [x, y] = positions[index];
      const label = stat.id === "visitors" ? "visitors (tracked identities)" : stat.label;
      const labelSize = stat.id === "visitors" ? 10.5 : 13;
      out.push(`<text x="${x}" y="${y}" font-size="29" font-weight="650" fill="#F0F6FC">${esc(display(stat))}</text>`);
      out.push(`<text x="${x}" y="${y + 20}" font-size="${labelSize}" font-weight="550" fill="#9AA7B5">${esc(label)}</text>`);
    });
  }

  return `<g>${out.join("")}</g>`;
}

function renderCardSvg(project) {
  const alt = cardAlt(project);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${CARD_WIDTH}" height="${CARD_HEIGHT}" viewBox="0 0 ${CARD_WIDTH} ${CARD_HEIGHT}" role="img" aria-label="${esc(alt)}" font-family="-apple-system,'Segoe UI',Helvetica,Arial,sans-serif"><title>${esc(alt)}</title>${cardContents(project)}</svg>\n`;
}

function cardAlt(project) {
  const stats = Object.entries(project.stats ?? {})
    .filter(([, stat]) => stat.status !== "unavailable" && typeof stat.value === "number" && Number.isFinite(stat.value))
    .map(([id, stat]) => ({ ...stat, id }));
  const metrics = stats.map((stat) => `${display(stat)} ${stat.id === "visitors" ? "visitors (tracked identities)" : stat.label}`);
  return metrics.some((_, index) => stats[index].value > 0)
    ? `${project.name}: ${metrics.join(". ")}`
    : `${project.name}: no qualifying counts yet`;
}

function renderBoard(projects) {
  const height = projects.length * CARD_HEIGHT + Math.max(0, projects.length - 1) * BOARD_GAP;
  const groups = projects.map((project, index) => `<g transform="translate(0 ${index * (CARD_HEIGHT + BOARD_GAP)})">${cardContents(project)}</g>`).join("");
  const alt = projects.map(cardAlt).join("; ");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${CARD_WIDTH}" height="${height}" viewBox="0 0 ${CARD_WIDTH} ${height}" role="img" aria-label="${esc(alt)}" font-family="-apple-system,'Segoe UI',Helvetica,Arial,sans-serif"><title>${esc(alt)}</title>${groups}</svg>\n`;
}

function formatUpdateDate(timestamp) {
  if (!timestamp) return "unknown";
  const date = dateInIST(timestamp);
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "UTC", day: "2-digit", month: "short", year: "numeric",
  }).format(new Date(`${date}T00:00:00Z`));
}

function renderReadmeBlock(data, visibleProjects) {
  const latestRefresh = data.generatedAt ?? visibleProjects.map((project) => project.queryRefreshedAt).filter(Boolean).sort().at(-1);
  const alt = visibleProjects.map(cardAlt).join(". ");
  return `${MARK_START}\n<p align="center">\n  <img src="stats/cards/desktop.svg" width="390" style="width:390px;max-width:none" alt="${esc(alt)}" />\n</p>\n<p align="center"><sub>Updated ${esc(formatUpdateDate(latestRefresh))}</sub></p>\n${MARK_END}`;
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
  const board = renderBoard(visible);
  await writeIfChanged(path.join(CARDS_DIR, "desktop.svg"), board);
  await writeIfChanged(path.join(CARDS_DIR, "mobile.svg"), board);

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
