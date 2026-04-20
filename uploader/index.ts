import { readdir, readFile, stat, mkdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import * as p from "@clack/prompts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");
const JOBS_DIR = join(REPO_ROOT, "jobs");
const TMP_DIR = join(__dirname, "tmp");

interface JobSummary {
  name: string;
  dir: string;
  startedAt: Date | null;
  finishedAt: Date | null;
  durationMs: number | null;
  completed: number;
  total: number;
  accuracy: number | null;
  status: "done" | "incomplete";
}

async function loadJob(name: string): Promise<JobSummary | null> {
  const dir = join(JOBS_DIR, name);
  const resultPath = join(dir, "result.json");
  if (!existsSync(resultPath)) return null;
  let result: any;
  try {
    result = JSON.parse(await readFile(resultPath, "utf8"));
  } catch {
    return null;
  }

  const startedAt = result.started_at ? new Date(result.started_at) : null;
  const finishedAt = result.finished_at ? new Date(result.finished_at) : null;
  const dirStat = await stat(dir);
  const status: JobSummary["status"] = finishedAt ? "done" : "incomplete";

  let durationMs: number | null = null;
  if (startedAt) {
    const endMs = finishedAt ? finishedAt.getTime() : dirStat.mtimeMs;
    durationMs = Math.max(0, endMs - startedAt.getTime());
  }

  let pass = 0;
  let fail = 0;
  const evals = result?.stats?.evals ?? {};
  for (const ev of Object.values<any>(evals)) {
    const bins = ev?.reward_stats?.reward ?? {};
    for (const [k, v] of Object.entries<any>(bins)) {
      if (!Array.isArray(v)) continue;
      const r = Number(k);
      if (r >= 1) pass += v.length;
      else fail += v.length;
    }
  }
  const total = Number(result.n_total_trials ?? 0);
  const completed = status === "done" ? total : pass + fail;
  const accDenom = status === "done" ? total : pass + fail;
  const accuracy = accDenom > 0 ? pass / accDenom : null;

  return {
    name,
    dir,
    startedAt,
    finishedAt,
    durationMs,
    completed,
    total,
    accuracy,
    status,
  };
}

function fmtDuration(ms: number | null): string {
  if (ms == null) return "?";
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}h${m}m`;
  if (m > 0) return `${m}m${sec}s`;
  return `${sec}s`;
}

function fmtTime(d: Date | null): string {
  if (!d) return "?";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(
    d.getHours(),
  )}:${pad(d.getMinutes())}`;
}

function fmtAcc(a: number | null): string {
  if (a == null) return "-";
  return (Math.round(a * 10000) / 100).toFixed(2) + "%";
}

function run(cmd: string, args: string[], opts: { cwd?: string } = {}): Promise<string> {
  return new Promise((resolveP, rejectP) => {
    const child = spawn(cmd, args, { cwd: opts.cwd, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d.toString()));
    child.stderr.on("data", (d) => (err += d.toString()));
    child.on("error", rejectP);
    child.on("close", (code) => {
      if (code === 0) resolveP(out);
      else rejectP(new Error(`${cmd} exited ${code}: ${err.trim()}`));
    });
  });
}

async function gitInfo(): Promise<{ hash: string; branch: string; message: string }> {
  const [hash, branch, message] = await Promise.all([
    run("git", ["rev-parse", "--short", "HEAD"], { cwd: REPO_ROOT }),
    run("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: REPO_ROOT }),
    run("git", ["log", "-1", "--pretty=%s"], { cwd: REPO_ROOT }),
  ]);
  return { hash: hash.trim(), branch: branch.trim(), message: message.trim() };
}

async function inferModels(
  jobDir: string,
): Promise<{ generator: string; evaluator: string }> {
  const entries = await readdir(jobDir, { withFileTypes: true });
  const trialDirs = entries.filter((e) => e.isDirectory()).map((e) => e.name);

  const generators = new Set<string>();
  const evaluators = new Set<string>();

  const genRe = /\[bench-runner\]\s+model:\s*([^\s|]+)/;
  const evalRe = /\[bench-runner\]\s+cross-validation:[^\n]*?evaluator=([^\s()]+)/;

  await Promise.all(
    trialDirs.map(async (t) => {
      const logPath = join(jobDir, t, "agent", "bench-runner.txt");
      if (!existsSync(logPath)) return;
      let head: string;
      try {
        head = (await readFile(logPath, "utf8")).slice(0, 8192);
      } catch {
        return;
      }
      const gm = head.match(genRe);
      if (gm) generators.add(gm[1]);
      const em = head.match(evalRe);
      if (em) evaluators.add(em[1]);
    }),
  );

  const fmt = (s: Set<string>) =>
    s.size === 0 ? "unknown" : Array.from(s).sort().join("/");
  return { generator: fmt(generators), evaluator: fmt(evaluators) };
}

async function sendTelegram(
  token: string,
  chatId: string,
  filePath: string,
  caption: string,
): Promise<void> {
  const fileName = filePath.split("/").pop()!;
  const buf = await readFile(filePath);
  const form = new FormData();
  form.append("chat_id", chatId);
  form.append("caption", caption);
  form.append("parse_mode", "HTML");
  form.append("document", new Blob([buf]), fileName);

  const res = await fetch(`https://api.telegram.org/bot${token}/sendDocument`, {
    method: "POST",
    body: form,
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`Telegram API ${res.status}: ${body}`);
  const json = JSON.parse(body);
  if (!json.ok) throw new Error(`Telegram error: ${body}`);
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

async function main() {
  const envPath = join(__dirname, ".env");
  if (!existsSync(envPath)) {
    p.log.error(`Missing ${envPath}. Copy .env.example to .env and fill it in.`);
    process.exit(1);
  }
  // Bun auto-loads .env from cwd; be explicit for clarity.
  const envText = await readFile(envPath, "utf8");
  const env: Record<string, string> = {};
  for (const line of envText.split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/i);
    if (!m) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))
      v = v.slice(1, -1);
    env[m[1]] = v;
  }
  const token = env.TELEGRAM_BOT_TOKEN;
  const chatId = env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) {
    p.log.error("TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID must be set in uploader/.env");
    process.exit(1);
  }

  p.intro("📦 kairos-bench jobs uploader");

  if (!existsSync(JOBS_DIR)) {
    p.log.error(`No jobs dir at ${JOBS_DIR}`);
    process.exit(1);
  }
  const names = (await readdir(JOBS_DIR, { withFileTypes: true }))
    .filter((e) => e.isDirectory())
    .map((e) => e.name);

  const jobs = (await Promise.all(names.map(loadJob))).filter(
    (j): j is JobSummary => j != null,
  );
  p.log.step(`Loaded ${jobs.length} jobs`);

  jobs.sort((a, b) => {
    const ta = a.startedAt?.getTime() ?? 0;
    const tb = b.startedAt?.getTime() ?? 0;
    return tb - ta;
  });
  const recent = jobs.slice(0, 10);
  if (recent.length === 0) {
    p.log.error("No jobs with result.json found");
    process.exit(1);
  }

  const rows = recent.map((j) => ({
    job: j,
    time: fmtTime(j.startedAt),
    dur: fmtDuration(j.durationMs),
    count: `${j.completed}/${j.total}`,
    acc: fmtAcc(j.accuracy),
    tag: j.status === "done" ? "" : "[incomplete]",
  }));
  const w = {
    time: Math.max(...rows.map((r) => r.time.length)),
    dur: Math.max(...rows.map((r) => r.dur.length)),
    count: Math.max(...rows.map((r) => r.count.length)),
    acc: Math.max(...rows.map((r) => r.acc.length)),
  };
  const pad = (s: string, n: number) => s + " ".repeat(Math.max(0, n - s.length));

  const selected = await p.select({
    message: "Choose a job to upload",
    options: rows.map((r) => {
      const label = `${pad(r.time, w.time)}  ${pad(r.dur, w.dur)}  ${pad(r.count, w.count)}  ${pad(r.acc, w.acc)}  ${r.tag}`.trimEnd();
      return { value: r.job.name, label, hint: r.job.name };
    }),
  });
  if (p.isCancel(selected)) {
    p.cancel("Cancelled");
    process.exit(0);
  }
  const job = recent.find((j) => j.name === selected)!;

  const git = await gitInfo();

  p.log.step("Inferring models from bench-runner logs …");
  const models = await inferModels(job.dir);
  p.log.success(`generator=${models.generator}, evaluator=${models.evaluator}`);

  const accTag = job.accuracy != null ? job.accuracy.toFixed(2) : "incomplete";
  const archiveName = `${git.hash}_${job.name}_${accTag}.7z`;

  await mkdir(TMP_DIR, { recursive: true });
  const archivePath = join(TMP_DIR, archiveName);
  if (existsSync(archivePath)) await rm(archivePath);

  p.log.step(`Packing ${archiveName} …`);
  const packStart = Date.now();
  try {
    await run("7z", ["a", "-mx=5", "-bd", "-bso0", "-bsp0", archivePath, job.name], {
      cwd: JOBS_DIR,
    });
  } catch (e) {
    p.log.error("Pack failed");
    throw e;
  }
  const size = (await stat(archivePath)).size;
  p.log.success(
    `Packed ${archiveName} (${(size / 1024 / 1024).toFixed(2)} MiB) in ${fmtDuration(Date.now() - packStart)}`,
  );

  const caption = [
    `<b>kairos-bench run</b>`,
    `<b>Job:</b> <code>${escapeHtml(job.name)}</code>`,
    `<b>Branch:</b> <code>${escapeHtml(git.branch)}</code>`,
    `<b>Commit:</b> <code>${escapeHtml(git.hash)}</code> — ${escapeHtml(git.message)}`,
    `<b>Started:</b> ${escapeHtml(fmtTime(job.startedAt))}`,
    `<b>Duration:</b> ${escapeHtml(fmtDuration(job.durationMs))}${job.status !== "done" ? ` (${job.status})` : ""}`,
    `<b>Completed:</b> ${job.completed}/${job.total}`,
    `<b>Accuracy:</b> ${escapeHtml(fmtAcc(job.accuracy))}`,
    `<b>Generator:</b> <code>${escapeHtml(models.generator)}</code>`,
    `<b>Evaluator:</b> <code>${escapeHtml(models.evaluator)}</code>`,
  ].join("\n");

  p.log.step("Uploading to Telegram …");
  const upStart = Date.now();
  try {
    await sendTelegram(token, chatId, archivePath, caption);
    p.log.success(`Uploaded in ${fmtDuration(Date.now() - upStart)}`);
  } catch (e) {
    p.log.error("Upload failed");
    throw e;
  } finally {
    await rm(archivePath, { force: true });
  }

  p.outro("✅ Done");
}

main().catch((e) => {
  p.log.error(e?.stack || String(e));
  process.exit(1);
});
