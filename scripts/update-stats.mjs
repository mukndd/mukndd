#!/usr/bin/env node
// Refreshes the live project stats shown on the profile README.
//
//   node scripts/update-stats.mjs
//
// Reads stats/projects.json, resolves every stat from its real source (commits
// API, git tree, a data file, or the latest passing CI run on the default
// branch), then writes stats/data.json, one SVG card per project in
// stats/cards/, and the block between the STATS markers in README.md.
//
// A stat that cannot be refreshed keeps its last verified value and date. It is
// marked "stale" once that date is more than STALE_AFTER_DAYS old, so a card never
// claims a freshness it didn't just verify. Private repo names never
// enter this public repo: they come from the STATS_REPOS env var (a JSON map of
// project id -> "owner/repo") or the gitignored stats/repos.local.json.
// Nothing below logs a repo name, because Actions logs on a public repo are public.
//
// Auth: GH_TOKEN / GITHUB_TOKEN, else `gh auth token`. Private repos need a
// read-only token (Contents, Actions, Metadata).

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
const STALE_AFTER_DAYS = 2;
const ageDays = (iso) => Math.floor((Date.parse(`${TODAY}T00:00:00Z`) - Date.parse(`${iso}T00:00:00Z`)) / 86_400_000);
const statusFor = (asOf) => (ageDays(asOf) > STALE_AFTER_DAYS ? "stale" : "live");

// ---------------------------------------------------------------- auth + http

function resolveToken() {
  const env = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  if (env) return env;
  try {
    return execFileSync("gh", ["auth", "token"], { encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}
const TOKEN = resolveToken();

class HttpError extends Error {
  constructor(status) {
    super(`HTTP ${status}`);
    this.status = status;
  }
}

async function gh(apiPath, { raw = false } = {}) {
  const res = await fetch(`https://api.github.com${apiPath}`, {
    headers: {
      Accept: raw ? "application/vnd.github.raw+json" : "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "mukndd-profile-stats",
      ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}),
    },
  });
  if (!res.ok) throw new HttpError(res.status);
  return res;
}

// ------------------------------------------------------------------ resolvers

const repoCache = new Map();
async function repoInfo(repo) {
  if (!repoCache.has(repo)) repoCache.set(repo, (await gh(`/repos/${repo}`)).json());
  return repoCache.get(repo);
}

async function countCommits(repo, branch, author) {
  const q = new URLSearchParams({ sha: branch, per_page: "1" });
  if (author) q.set("author", author);
  const res = await gh(`/repos/${repo}/commits?${q}`);
  // With per_page=1 the last page number is the commit count.
  const last = (res.headers.get("link") ?? "").match(/<[^>]*[?&]page=(\d+)[^>]*>;\s*rel="last"/);
  return last ? Number(last[1]) : (await res.json()).length;
}

async function resolveCommits({ repo, branch, source }) {
  const [authored, total] = await Promise.all([
    countCommits(repo, branch, source.author),
    countCommits(repo, branch),
  ]);
  return { value: authored, detail: { total } };
}

async function resolveTreeCount({ repo, branch, source }) {
  const tree = await (await gh(`/repos/${repo}/git/trees/${encodeURIComponent(branch)}?recursive=1`)).json();
  if (tree.truncated) throw new Error("tree truncated");
  const match = new RegExp(source.match);
  const exclude = source.exclude ? new RegExp(source.exclude) : null;
  const value = tree.tree.filter((e) => e.type === "blob" && match.test(e.path) && !(exclude && exclude.test(e.path))).length;
  if (value === 0) throw new Error("pattern matched nothing");
  return { value };
}

async function fileText({ repo, branch, source }) {
  const p = source.path.split("/").map(encodeURIComponent).join("/");
  return (await gh(`/repos/${repo}/contents/${p}?ref=${encodeURIComponent(branch)}`, { raw: true })).text();
}

async function resolveJson(ctx) {
  const doc = JSON.parse(await fileText(ctx));
  const nums = ctx.source.pick.map((key) => key.split(".").reduce((o, k) => o?.[k], doc));
  if (nums.some((n) => typeof n !== "number")) throw new Error("picked field is not a number");
  return { value: nums.reduce((a, b) => a + b, 0) };
}

async function resolveFileRegex(ctx) {
  const m = (await fileText(ctx)).match(new RegExp(ctx.source.pattern));
  if (!m) throw new Error("pattern not found");
  const value = Number(m[1].replace(/,/g, ""));
  if (!Number.isFinite(value)) throw new Error("not a number");
  return { value };
}

// Latest successful run on the default branch, then its job logs. Vitest prints
// "Tests  347 passed", so a regex over the log gives a count straight from CI.
async function resolveCi({ repo, branch, source }) {
  const q = new URLSearchParams({ branch, status: "success", per_page: "10" });
  if (source.event) q.set("event", source.event);
  const { workflow_runs: runs } = await (await gh(`/repos/${repo}/actions/runs?${q}`)).json();
  if (!runs?.length) throw new Error("no successful CI run");
  const run = runs[0];
  const { jobs } = await (await gh(`/repos/${repo}/actions/runs/${run.id}/jobs`)).json();
  const re = new RegExp(source.pattern);
  for (const job of jobs) {
    const log = (await (await gh(`/repos/${repo}/actions/jobs/${job.id}/logs`)).text()).replace(/\x1b\[[0-9;]*m/g, "");
    const m = log.match(re);
    if (m) return { value: Number(m[1]), detail: { runDate: run.updated_at.slice(0, 10) } };
  }
  throw new Error("pattern not found in CI log");
}

const RESOLVERS = {
  commits: resolveCommits,
  "tree-count": resolveTreeCount,
  json: resolveJson,
  "file-regex": resolveFileRegex,
  ci: resolveCi,
};

// ----------------------------------------------------------------------- main

async function readJson(file, fallback) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return fallback;
  }
}

async function loadRepoMap() {
  if (process.env.STATS_REPOS) return JSON.parse(process.env.STATS_REPOS);
  return readJson(path.join(STATS_DIR, "repos.local.json"), {});
}

async function collect() {
  const config = await readJson(path.join(STATS_DIR, "projects.json"), null);
  if (!config) throw new Error("stats/projects.json missing");
  const previous = await readJson(path.join(STATS_DIR, "data.json"), { projects: {} });
  const repoMap = await loadRepoMap();
  const out = { generatedAt: TODAY, projects: {} };

  for (const project of config.projects) {
    const repo = repoMap[project.id] ?? project.repo;
    const prev = previous.projects?.[project.id] ?? { stats: {} };
    const entry = { name: project.name, url: project.url, pushedAt: prev.pushedAt ?? null, stats: {} };
    let ctxBase = null;

    if (repo) {
      try {
        const info = await repoInfo(repo);
        ctxBase = { repo, branch: info.default_branch };
        entry.pushedAt = info.pushed_at.slice(0, 10);
      } catch (err) {
        console.warn(`${project.id}: repo not readable (${err.message}); keeping last known values`);
      }
    } else {
      console.warn(`${project.id}: no repo configured; keeping last known values`);
    }

    for (const stat of project.stats) {
      const last = prev.stats?.[stat.id];
      let resolved = null;
      if (ctxBase) {
        try {
          resolved = await RESOLVERS[stat.source.type]({ ...ctxBase, source: stat.source });
        } catch (err) {
          console.warn(`${project.id}.${stat.id}: failed (${err.message}); keeping last known value`);
        }
      }
      const base = { label: stat.label, ...(stat.sub && { sub: stat.sub }), ...(stat.suffix && { suffix: stat.suffix }), source: stat.source.type };
      if (resolved) {
        entry.stats[stat.id] = { ...base, value: resolved.value, status: "live", asOf: TODAY, ...(resolved.detail && { detail: resolved.detail }) };
      } else if (last) {
        entry.stats[stat.id] = { ...base, value: last.value, status: statusFor(last.asOf), asOf: last.asOf, ...(last.detail && { detail: last.detail }) };
      } else {
        throw new Error(`${project.id}.${stat.id}: no live value and nothing to fall back to`);
      }
      console.log(`${project.id}.${stat.id}: ${entry.stats[stat.id].value} (${resolved ? "refreshed" : `kept from ${entry.stats[stat.id].asOf}`}, ${entry.stats[stat.id].status})`);
    }
    out.projects[project.id] = entry;
  }
  return { config, data: out };
}

// ------------------------------------------------------------------ rendering

const fmtNumber = (n) => new Intl.NumberFormat("en-US").format(n);
const fmtDate = (iso) => new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const display = (s) => `${fmtNumber(s.value)}${s.suffix ?? ""}`;

// Stat-tile card: label above the value would bury the number, so the value
// leads, the label sits under it in muted ink. Colour carries state only (the
// status dot); all text uses text inks.
function renderCard(project) {
  const W = 400;
  const H = 168;
  const stats = Object.values(project.stats);
  const colW = (W - 48) / stats.length;
  const live = stats.filter((s) => s.status === "live").length;
  const stale = stats.length - live;
  const dot = stale ? "#D29922" : "#3FB950";
  const status = stale ? `${stale} stale` : "live";
  const oldest = stats.map((s) => s.asOf).sort()[0];
  const stamp = stale ? `last live ${fmtDate(oldest)}` : `checked ${fmtDate(oldest)}`;
  const footer = [`${status}`, project.pushedAt && `last push ${fmtDate(project.pushedAt)}`].filter(Boolean).join(" · ");

  // One value size per card so the row reads as a set; fit it to the longest value.
  const longest = Math.max(...stats.map((s) => display(s).length));
  const size = longest <= 4 ? 32 : longest <= 6 ? 28 : 25;
  const tiles = stats
    .map((s, i) => {
      const x = 24 + i * colW;
      const text = display(s);
      return [
        `<text x="${x}" y="92" font-size="${size}" font-weight="600" fill="#E6EDF3">${esc(text)}</text>`,
        `<text x="${x}" y="113" font-size="12.5" fill="#8B949E">${esc(s.label)}</text>`,
        s.sub ? `<text x="${x}" y="128" font-size="11" fill="#6E7681">${esc(s.sub)}</text>` : "",
      ].join("");
    })
    .join("");

  const alt = `${project.name}: ${stats.map((s) => `${display(s)} ${s.label}`).join(", ")}`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(alt)}" font-family="-apple-system,'Segoe UI',Helvetica,Arial,sans-serif">
<title>${esc(alt)}</title>
<rect x="0.5" y="0.5" width="${W - 1}" height="${H - 1}" rx="14" fill="#0D1117" stroke="#30363D"/>
<rect x="24" y="0" width="40" height="3" rx="1.5" fill="#A78BFA"/>
<text x="24" y="38" font-size="16" font-weight="600" fill="#E6EDF3">${esc(project.name)}</text>
<text x="${W - 24}" y="38" font-size="11" fill="#8B949E" text-anchor="end">${esc(stamp)}</text>
<line x1="24" y1="52" x2="${W - 24}" y2="52" stroke="#21262D"/>
${tiles}
<circle cx="29" cy="150" r="3.5" fill="${dot}"/>
<text x="38" y="154" font-size="11" fill="#8B949E">${esc(footer)}</text>
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
  const caption = `<p align="center"><sub>Recomputed daily by a GitHub Action from each repo's default branch, data files and latest passing CI run. A number that can't be refreshed turns amber and keeps its last verified value. Sources and dates: <a href="stats/data.json">stats/data.json</a>.</sub></p>`;
  return `${MARK_START}\n${rows.join("\n")}\n${caption}\n${MARK_END}`;
}

async function writeIfChanged(file, content) {
  const existing = existsSync(file) ? await readFile(file, "utf8") : null;
  if (existing === content) return false;
  await writeFile(file, content);
  return true;
}

const { data } = await collect();
await mkdir(CARDS_DIR, { recursive: true });

await writeIfChanged(path.join(STATS_DIR, "data.json"), `${JSON.stringify(data, null, 2)}
`);

for (const [id, project] of Object.entries(data.projects)) {
  await writeIfChanged(path.join(CARDS_DIR, `${id}.svg`), renderCard(project));
}

const readme = await readFile(README, "utf8");
const start = readme.indexOf(MARK_START);
const end = readme.indexOf(MARK_END);
if (start === -1 || end === -1 || end < start) throw new Error("README.md is missing the STATS markers");
const next = readme.slice(0, start) + renderReadmeBlock(data) + readme.slice(end + MARK_END.length);
await writeIfChanged(README, next);
console.log("done");
