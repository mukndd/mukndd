import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const script = path.join(ROOT, "scripts", "update-stats.mjs");
const sqlResult = spawnSync(process.execPath, [script, "--print-sql"], { encoding: "utf8" });
assert.equal(sqlResult.status, 0, sqlResult.stderr);

function queryFor(name) {
  const start = sqlResult.stdout.indexOf(`-- ${name}\n`);
  assert.notEqual(start, -1, `missing generated query ${name}`);
  const end = sqlResult.stdout.indexOf("\n-- ", start + 1);
  return sqlResult.stdout.slice(start, end < 0 ? undefined : end);
}

function fixture(t, updateData = () => {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), "mukndd-stats-test-"));
  t.after(() => {
    assert.equal(path.dirname(root).toLowerCase(), os.tmpdir().toLowerCase());
    rmSync(root, { recursive: true, force: true });
  });
  for (const relative of ["README.md", "scripts/update-stats.mjs", "stats/projects.json", "stats/data.json"]) {
    const destination = path.join(root, relative);
    const parent = path.dirname(destination);
    mkdirSync(parent, { recursive: true });
    copyFileSync(path.join(ROOT, relative), destination);
  }
  const dataPath = path.join(root, "stats", "data.json");
  const data = JSON.parse(readFileSync(dataPath, "utf8"));
  updateData(data);
  writeFileSync(dataPath, `${JSON.stringify(data, null, 2)}\n`);
  const run = spawnSync(process.execPath, [path.join(root, "scripts", "update-stats.mjs"), "--render-only"], {
    cwd: root,
    encoding: "utf8",
  });
  assert.equal(run.status, 0, run.stderr);
  return {
    data,
    read(relative) { return readFileSync(path.join(root, relative), "utf8"); },
  };
}

test("missing user-agent rows remain eligible as unknown", () => {
  const sql = queryFor("findin.visitors");
  const qualifying = sql.split("\n").find((line) => line.includes("AS qualifying_event_rows"));
  assert.match(qualifying, /isNull\(properties\.\$raw_user_agent\) OR properties\.\$raw_user_agent = ''/);
  assert.match(qualifying, /OR NOT isLikelyBot\(properties\.\$raw_user_agent\)/);
});

test("known-bot user-agents are excluded", () => {
  const sql = queryFor("findin.visitors");
  const qualifying = sql.split("\n").find((line) => line.includes("AS qualifying_event_rows"));
  assert.match(qualifying, /OR NOT isLikelyBot\(properties\.\$raw_user_agent\)/);
  assert.doesNotMatch(qualifying, /OR isLikelyBot\(properties\.\$raw_user_agent\)/);
});

test("the configured test cohort is excluded", () => {
  const sql = queryFor("findin.visitors");
  const qualifying = sql.split("\n").find((line) => line.includes("AS qualifying_event_rows"));
  assert.match(qualifying, /person_id NOT IN COHORT 529631/);
});

test("Asterisms keeps its production-host selector", () => {
  const sql = queryFor("asterisms.visitors");
  assert.match(sql, /properties\.\$host IN \('asterisms\.space'\)/);
});

test("zero-count projects use a short status line and the board stays one centered 390px column", (t) => {
  const rendered = fixture(t, (data) => {
    for (const id of ["portfolio", "chromelo"]) {
      for (const stat of Object.values(data.projects[id].stats)) {
        stat.value = null;
        stat.status = "unavailable";
      }
    }
    data.projects.asterisms.stats.this_week.value = null;
    data.projects.asterisms.stats.this_week.status = "unavailable";
  });
  const readme = rendered.read("README.md");
  const board = rendered.read("stats/cards/desktop.svg");
  assert.match(readme, /<p align="center">\s*<img src="stats\/cards\/desktop\.svg" width="390" style="width:390px;max-width:none"/);
  assert.doesNotMatch(readme, /<picture>|stats\/cards\/mobile\.svg|Through |Checked /);
  const statsBlock = readme.slice(readme.indexOf("<!-- STATS:START -->"), readme.indexOf("<!-- STATS:END -->"));
  assert.doesNotMatch(statsBlock, /\bhumans?\b|real people/i);
  const updateDate = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kolkata", day: "2-digit", month: "short", year: "numeric" }).format(new Date(rendered.data.generatedAt));
  assert.ok(readme.includes(`Updated ${updateDate}`));
  assert.equal(board, rendered.read("stats/cards/mobile.svg"));
  assert.match(board, /^<svg[^>]*width="390"/);
  assert.deepEqual([...board.matchAll(/transform="translate\((\d+) (\d+)\)"/g)].map((m) => [Number(m[1]), Number(m[2])]), [[0, 0], [0, 222], [0, 444], [0, 666]]);
  assert.match(board, />Findin<\/text>/);
  assert.match(board, />Asterisms<\/text>/);
  assert.match(board, />Portfolio<\/text>/);
  assert.match(board, />Chromelo<\/text>/);
  assert.equal([...board.matchAll(/No qualifying counts yet/g)].length, 2);
  const asterisms = board.slice(board.indexOf(">Asterisms</text>"), board.indexOf(">Portfolio</text>"));
  assert.doesNotMatch(asterisms, />this week<\/text>/);
});

test("the generator automatically fills Portfolio and Chromelo cards when counts become available", (t) => {
  const rendered = fixture(t, (data) => {
    for (const id of ["portfolio", "chromelo"]) {
      for (const stat of Object.values(data.projects[id].stats)) {
        stat.value = 7;
        stat.status = "live";
        stat.verified = true;
      }
    }
  });
  const board = rendered.read("stats/cards/desktop.svg");
  assert.match(board, /Portfolio: 7 visitors \(tracked identities\)/);
  assert.match(board, /Chromelo: 7 visitors \(tracked identities\)/);
  assert.doesNotMatch(board, /No qualifying counts yet/);
});
