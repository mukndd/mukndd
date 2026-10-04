#!/usr/bin/env node
// Refreshes the project stats shown on the profile README.
//
//   node scripts/update-stats.mjs              refresh everything
//   node scripts/update-stats.mjs --print-sql  print the PostHog query behind each stat
//
// Reads stats/projects.json, resolves every stat from its source, then writes
// stats/data.json, one SVG card per project in stats/cards/, and the block
// between the STATS markers in README.md.
//
// Sources:
//   posthog     human visitors / players / countries counted in PostHog on the
//               production hosts, excluding bots and the internal test-account
//               cohort. Needs POSTHOG_API_KEY (a read-only personal API key).
//   file-regex  a figure stated in a public repo file (Flyweight's README).
//               Needs only GH_TOKEN / GITHUB_TOKEN, or `gh auth token` locally.
//
// A stat that cannot be refreshed keeps its last value and date, and the run
// exits non-zero. A card says "live" only if every stat on it was refreshed within
// STALE_AFTER_DAYS; otherwise it says "snapshot" with the date, so it never claims
// a freshness it didn't just verify. Projects with "live": false never show that badge.

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
const TODAY = NOW.toISOString().slice(0, 10);
const STALE_AFTER_DAYS = 1;
let notRefreshed = 0;
const ageDays = (iso) => Math.floor((Date.parse(`${TODAY}T00:00:00Z`) - Date.parse(`${iso}T00:00:00Z`)) / 86_400_000);
const statusFor = (asOf) => (ageDays(asOf) > STALE_AFTER_DAYS ? "snapshot" : "live");

// ----------------------------------------------------------------- resolvers

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
  const m = (await res.text()).match(new RegExp(source.pattern));
  if (!m) throw new Error("pattern not found");
  const value = Number(m[1].replace(/,/g, ""));
  if (!Number.isFinite(value)) throw new Error("not a number");
  return { value };
}

const SAFE = /^[\w$.:-]+$/;
const sqlList = (items) => {
  for (const item of items) if (!SAFE.test(item)) throw new Error(`unsafe value in config: ${item}`);
  return items.map((i) => `'${i}'`).join(", ");
};

// One number from the events table: unique people, or unique countries, among
// real visitors on the given production hosts.
function posthogSql(config, source) {
  const select =
    source.measure === "countries"
      ? "uniqIf(properties.$geoip_country_code, isNotNull(properties.$geoip_country_code) AND properties.$geoip_country_code != '')"
      : "uniq(person_id)";
  return [
    `SELECT ${select}`,
    "FROM events",
    `WHERE timestamp >= toDateTime('${config.since} 00:00:00')`,
    `  AND properties.$host IN (${sqlList(source.hosts)})`,
    `  AND event IN (${sqlList(source.events)})`,
    `  AND person_id NOT IN COHORT ${Number(config.excludeCohort)}`,
    "  AND NOT isLikelyBot(properties.$raw_user_agent)",
  ].join("\n");
}

async function resolvePosthog({ config, source }) {
  const key = process.env.POSTHOG_API_KEY;
  if (!key) throw new Error("POSTHOG_API_KEY not set");
  const res = await fetch(`${config.host}/api/projects/${Number(config.projectId)}/query/`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query: { kind: "HogQLQuery", query: posthogSql(config, source) }, name: "profile-stats" }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const value = (await res.json()).results?.[0]?.[0];
  if (typeof value !== "number") throw new Error("unexpected response shape");
  return { value };
}

const RESOLVERS = { posthog: resolvePosthog, "file-regex": resolveFileRegex };

// ---------------------------------------------------------------------- main

async function readJson(file, fallback) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return fallback;
  }
}

async function collect(config) {
  const previous = await readJson(path.join(STATS_DIR, "data.json"), { projects: {} });
  const out = { generatedAt: TODAY, projects: {} };

  for (const project of config.projects) {
    const prev = previous.projects?.[project.id] ?? { stats: {} };
    const entry = {
      name: project.name,
      url: project.url,
      ...(project.window && { window: project.window }),
      ...(project.live === false && { live: false }),
      pushedAt: project.repo ? (prev.pushedAt ?? null) : null,
      stats: {},
    };

    if (project.repo) {
      try {
        entry.pushedAt = (await repoMeta(project.repo)).pushed_at.slice(0, 10);
      } catch {
        // keep the previous pushedAt
      }
    }

    for (const stat of project.stats) {
      const last = prev.stats?.[stat.id];
      let resolved = null;
      try {
        resolved = await RESOLVERS[stat.source.type]({ config: config.posthog, project, source: stat.source });
      } catch (err) {
        notRefreshed++;
        console.warn(`${project.id}.${stat.id}: not refreshed (${err.message})`);
      }
      const base = { label: stat.label, ...(stat.sub && { sub: stat.sub }), ...(stat.suffix && { suffix: stat.suffix }), source: stat.source.type };
      if (resolved) {
        entry.stats[stat.id] = { ...base, value: resolved.value, status: "live", asOf: TODAY };
      } else if (last) {
        entry.stats[stat.id] = { ...base, value: last.value, status: statusFor(last.asOf), asOf: last.asOf };
      } else {
        throw new Error(`${project.id}.${stat.id}: no value and nothing to fall back to`);
      }
      const s = entry.stats[stat.id];
      console.log(`${project.id}.${stat.id}: ${s.value} (${resolved ? "refreshed" : `kept from ${s.asOf}`}, ${s.status})`);
    }
    out.projects[project.id] = entry;
  }
  return out;
}

// ----------------------------------------------------------------- rendering

const fmtNumber = (n) => new Intl.NumberFormat("en-US").format(n);
const fmtDate = (iso) => new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const display = (s) => `${fmtNumber(s.value)}${s.suffix ?? ""}`;

// Stat-tile card: the value leads, the label sits under it in muted ink. Colour
// carries state only (the status dot); all text uses text inks.
function renderCard(project) {
  const W = 400;
  const H = 168;
  const stats = Object.values(project.stats);
  const colW = (W - 48) / stats.length;
  const showStatus = project.live !== false;
  const allLive = stats.every((s) => s.status === "live");
  const oldest = stats.map((s) => s.asOf).sort()[0];

  const stamp = showStatus ? (project.window ?? "") : "";
  let footer = "";
  if (showStatus) footer = allLive ? `live · updated ${fmtDate(oldest)}` : `snapshot · ${fmtDate(oldest)}`;
  else if (project.pushedAt) footer = `last push ${fmtDate(project.pushedAt)}`;
  const dot = allLive ? "#3FB950" : "#6E7681";

  // One value size per card so the row reads as a set; fit it to the longest value.
  const longest = Math.max(...stats.map((s) => display(s).length));
  const size = longest <= 4 ? 32 : longest <= 6 ? 28 : 25;
  const tiles = stats
    .map((s, i) => {
      const x = 24 + i * colW;
      return [
        `<text x="${x}" y="92" font-size="${size}" font-weight="600" fill="#E6EDF3">${esc(display(s))}</text>`,
        `<text x="${x}" y="113" font-size="12.5" fill="#8B949E">${esc(s.label)}</text>`,
        s.sub ? `<text x="${x}" y="128" font-size="11" fill="#6E7681">${esc(s.sub)}</text>` : "",
      ].join("");
    })
    .join("");

  const alt = `${project.name}: ${stats.map((s) => `${display(s)} ${s.label}`).join(", ")}`;
  const footerSvg = footer
    ? `${showStatus ? `<circle cx="29" cy="150" r="3.5" fill="${dot}"/>` : ""}<text x="${showStatus ? 38 : 24}" y="154" font-size="11" fill="#8B949E">${esc(footer)}</text>`
    : "";
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(alt)}" font-family="-apple-system,'Segoe UI',Helvetica,Arial,sans-serif">
<title>${esc(alt)}</title>
<rect x="0.5" y="0.5" width="${W - 1}" height="${H - 1}" rx="14" fill="#0D1117" stroke="#30363D"/>
<rect x="24" y="0" width="40" height="3" rx="1.5" fill="#A78BFA"/>
<text x="24" y="38" font-size="16" font-weight="600" fill="#E6EDF3">${esc(project.name)}</text>
${stamp ? `<text x="${W - 24}" y="38" font-size="11" fill="#8B949E" text-anchor="end">${esc(stamp)}</text>` : ""}
<line x1="24" y1="52" x2="${W - 24}" y2="52" stroke="#21262D"/>
${tiles}
${footerSvg}
</svg>
`;
}

function renderReadmeBlock(data) {
  const cell = (id) => {
    const p = data.projects[id];
    const alt = `${p.name}: ${Object.values(p.stats).map((s) => `${display(s)} ${s.label}`).join(", ")}`;
    return `  <a href="${p.url}"><img src="stats/cards/${id}.svg" width="49%" alt="${esc(alt)}" /></a>`;
  };
  const ids = Object.keys(data.projects);
  const rows = [];
  for (let i = 0; i < ids.length; i += 2) rows.push(`<p align="center">\n${ids.slice(i, i + 2).map(cell).join("\n")}\n</p>`);
  const caption = `<p align="center"><sub>Real people, not repo stats: unique human visitors and players on the production sites, counted in PostHog with bots and my own test accounts excluded. A GitHub Action refreshes them when it can reach PostHog; otherwise a card shows a dated snapshot. Flyweight shows figures stated in its README. Details: <a href="stats/data.json">stats/data.json</a>.</sub></p>`;
  return `${MARK_START}\n${rows.join("\n")}\n${caption}\n${MARK_END}`;
}

async function writeIfChanged(file, content) {
  const existing = existsSync(file) ? await readFile(file, "utf8") : null;
  if (existing === content) return;
  await writeFile(file, content);
}

const config = await readJson(path.join(STATS_DIR, "projects.json"), null);
if (!config) throw new Error("stats/projects.json missing");

if (process.argv.includes("--print-sql")) {
  for (const project of config.projects)
    for (const stat of project.stats)
      if (stat.source.type === "posthog") console.log(`-- ${project.id}.${stat.id}\n${posthogSql(config.posthog, stat.source)}\n`);
  process.exit(0);
}

const data = await collect(config);
await mkdir(CARDS_DIR, { recursive: true });
await writeIfChanged(path.join(STATS_DIR, "data.json"), `${JSON.stringify(data, null, 2)}\n`);
for (const [id, project] of Object.entries(data.projects)) {
  await writeIfChanged(path.join(CARDS_DIR, `${id}.svg`), renderCard(project));
}

const readme = await readFile(README, "utf8");
const start = readme.indexOf(MARK_START);
const end = readme.indexOf(MARK_END);
if (start === -1 || end === -1 || end < start) throw new Error("README.md is missing the STATS markers");
await writeIfChanged(README, readme.slice(0, start) + renderReadmeBlock(data) + readme.slice(end + MARK_END.length));
console.log("done");

// Files are written first so the kept values still get committed, but a stat that
// could not refresh must not pass silently: it fails the run so GitHub emails it.
if (notRefreshed) {
  console.error(`${notRefreshed} stat(s) were not refreshed`);
  process.exitCode = 1;
}
