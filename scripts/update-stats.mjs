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

function cardHeight(project, mobile = false) {
  const hasCount = Object.values(project.stats ?? {}).some((stat) => stat.status !== "unavailable");
  if (project.trackingStatus !== "tracked") return mobile ? 184 : 174;
  return hasCount ? (mobile ? 220 : 218) : (mobile ? 184 : 174);
}

function fmtIST(timestamp) {
  if (!timestamp) return "not available";
  const formatted = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kolkata", day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).format(new Date(timestamp));
  return `${formatted} IST`;
}

function fmtCompactDate(timestamp) {
  if (!timestamp) return null;
  return new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kolkata", day: "2-digit", month: "short" }).format(new Date(timestamp));
}

function cardContents(project, mobile = false) {
  const width = mobile ? 390 : 580;
  const height = cardHeight(project, mobile);
  const stats = Object.values(project.stats ?? {});
  const tracked = project.trackingStatus === "tracked" && stats.length > 0;
  const availableStats = stats.filter((stat) => stat.status !== "unavailable");
  const title = esc(project.name);
  const latestIncluded = fmtCompactDate(project.latestIncludedEventAt);
  const checked = fmtCompactDate(project.queryRefreshedAt);
  const freshness = latestIncluded ? `Through ${latestIncluded}` : checked ? `Checked ${checked}` : "Not checked";
  const statusDot = project.trackingStatus !== "tracked" || stats.some((stat) => stat.status !== "live") ? "#8B949E" : "#3FB950";
  const out = [
    `<rect x="0.5" y="0.5" width="${width - 1}" height="${height - 1}" rx="14" fill="#0D1117" stroke="#30363D"/>`,
    `<rect x="24" y="0" width="40" height="3" rx="1.5" fill="${statusDot}"/>`,
    `<text x="24" y="36" font-size="${mobile ? 18 : 20}" font-weight="600" fill="#E6EDF3">${title}</text>`,
    `<circle cx="${width - 112}" cy="31" r="3" fill="${statusDot}"/>`,
    `<text x="${width - 102}" y="35" text-anchor="start" font-size="${mobile ? 10.5 : 11.5}" fill="#9AA7B5">${esc(freshness)}</text>`,
    `<line x1="24" y1="52" x2="${width - 24}" y2="52" stroke="#30363D"/>`,
  ];

  if (!tracked) {
    out.push(`<rect x="24" y="70" width="${width - 48}" height="${height - 92}" rx="10" fill="#10151C" stroke="#222B36"/>`);
    out.push(`<text x="${width / 2}" y="${mobile ? 121 : 116}" text-anchor="middle" font-size="${mobile ? 18 : 19}" font-weight="600" fill="#E6EDF3">Tracking not live yet</text>`);
    out.push(`<text x="${width / 2}" y="${mobile ? 146 : 142}" text-anchor="middle" font-size="${mobile ? 11.5 : 12.5}" fill="#8B949E">No production events observed</text>`);
  } else if (availableStats.length === 0) {
    out.push(`<rect x="24" y="70" width="${width - 48}" height="${height - 92}" rx="10" fill="#10151C" stroke="#222B36"/>`);
    out.push(`<text x="${width / 2}" y="${mobile ? 119 : 115}" text-anchor="middle" font-size="${mobile ? 17 : 19}" font-weight="600" fill="#E6EDF3">No qualifying counts yet</text>`);
    out.push(`<text x="${width / 2}" y="${mobile ? 144 : 141}" text-anchor="middle" font-size="${mobile ? 11.5 : 12.5}" fill="#8B949E">Recent events are filtered as bots</text>`);
  } else {
    const gap = mobile ? 10 : 12;
    const tileWidth = (width - 48 - gap) / 2;
    const tileHeight = mobile ? 62 : 63;
    const xPositions = [24, 24 + tileWidth + gap];
    const yPositions = [66, 66 + tileHeight + 10];
    stats.slice(0, 4).forEach((stat, index) => {
      const x = xPositions[index % 2];
      const y = yPositions[Math.floor(index / 2)];
      const unavailable = stat.status === "unavailable";
      out.push(`<rect x="${x}" y="${y}" width="${tileWidth}" height="${tileHeight}" rx="9" fill="#10151C" stroke="#222B36"/>`);
      out.push(`<text x="${x + 14}" y="${y + 31}" font-size="${mobile ? 27 : 29}" font-weight="650" fill="${unavailable ? "#8B949E" : "#F0F6FC"}">${esc(display(stat))}</text>`);
      out.push(`<text x="${x + 14}" y="${y + 51}" font-size="${mobile ? 12.5 : 13}" font-weight="550" fill="#9AA7B5">${esc(stat.label)}</text>`);
    });
  }

  return `<g>${out.join("")}</g>`;
}

function renderCardSvg(project) {
  const width = 580, height = cardHeight(project);
  const latestEventAt = project.latestIncludedEventAt ?? null;
  const alt = project.trackingStatus === "tracked"
    ? `${project.name}: ${Object.values(project.stats).map((stat) => `${stat.status === "unavailable" ? "unavailable" : display(stat)} ${stat.label}`).join(". ")}. ${project.dataQualityNote ?? "Tracked identities, with bots and internal test accounts excluded."} ${latestEventAt ? `Latest qualifying activity ${fmtIST(latestEventAt)}.` : `Checked ${fmtIST(project.queryRefreshedAt)}.`}`
    : `${project.name}: tracking not live yet. No production events observed. Checked ${fmtIST(project.queryRefreshedAt)}.`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(alt)}" font-family="-apple-system,'Segoe UI',Helvetica,Arial,sans-serif"><title>${esc(alt)}</title>${cardContents(project)}</svg>\n`;
}

function renderBoard(projects, mobile = false) {
  const width = mobile ? 390 : 1200;
  const cardWidth = mobile ? 390 : 580;
  const gap = mobile ? 12 : 16;
  const margin = mobile ? 0 : 10;
  const columns = mobile ? 1 : 2;
  const rows = Math.ceil(projects.length / columns);
  const rowHeights = Array.from({ length: rows }, (_, row) => Math.max(...projects.slice(row * columns, (row + 1) * columns).map((project) => cardHeight(project, mobile))));
  const rowOffsets = rowHeights.map((_, row) => margin + rowHeights.slice(0, row).reduce((sum, value) => sum + value + gap, 0));
  const height = margin * 2 + rowHeights.reduce((sum, value) => sum + value, 0) + (rows - 1) * gap;
  const groups = projects.map((project, index) => {
    const x = margin + (index % columns) * (cardWidth + gap);
    const y = rowOffsets[Math.floor(index / columns)];
    return `<g transform="translate(${x} ${y})">${cardContents(project, mobile)}</g>`;
  }).join("");
  const alt = projects.map((project) => project.trackingStatus === "tracked"
    ? `${project.name}: ${Object.values(project.stats).map((stat) => `${stat.status === "unavailable" ? "unavailable" : display(stat)} ${stat.label}`).join(". ")}. ${project.latestIncludedEventAt ? `Latest qualifying activity ${fmtIST(project.latestIncludedEventAt)}.` : `Checked ${fmtIST(project.queryRefreshedAt)}.`}`
    : `${project.name}: tracking not live yet. Checked ${fmtIST(project.queryRefreshedAt)}.`).join("; ");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(alt)}" font-family="-apple-system,'Segoe UI',Helvetica,Arial,sans-serif"><title>${esc(alt)}</title>${groups}</svg>\n`;
}

function renderReadmeBlock(data, visibleProjects) {
  const caption = `Tracked identities; bots and my test accounts excluded · “this week” = rolling 7 days · counts since 25 Aug 2026 · — = unavailable · <a href="stats/data.json">data</a>`;
  const alt = visibleProjects.map((project) => project.trackingStatus === "tracked"
    ? `${project.name}: ${Object.values(project.stats).map((stat) => `${stat.status === "unavailable" ? "unavailable" : display(stat)} ${stat.label}`).join(". ")}. ${project.latestIncludedEventAt ? `Latest qualifying activity ${fmtIST(project.latestIncludedEventAt)}.` : `Checked ${fmtIST(project.queryRefreshedAt)}.`}`
    : `${project.name}: tracking not live yet; no production events observed`).join(". ");
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
