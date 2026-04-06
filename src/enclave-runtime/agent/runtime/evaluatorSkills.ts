/**
 * Evaluator skills — concrete, copy-paste-ready test recipes.
 *
 * Unlike prompt "guidelines" that ask the LLM to *invent* the right test,
 * a skill provides an executable template the LLM only needs to *adapt*
 * (fill in module path, function name, etc.).
 */

// ── Skill type ───────────────────────────────────────────────

export interface EvaluatorSkill {
  id: string;
  name: string;
  /** All keywords must appear (case-insensitive) for the skill to activate. */
  triggers: string[][];
  /** The recipe injected into the evaluator prompt. */
  recipe: string;
}

// ── Skill registry ───────────────────────────────────────────

export const EVALUATOR_SKILLS: EvaluatorSkill[] = [
  {
    id: "concurrency-signal-cleanup",
    name: "Concurrency + Signal Cleanup",
    triggers: [
      ["concurrent", "signal"],
      ["concurrent", "cancel"],
      ["concurrent", "interrupt"],
      ["concurrent", "sigint"],
      ["semaphore", "signal"],
      ["semaphore", "cancel"],
      ["semaphore", "interrupt"],
      ["max_concurrent", "cancel"],
      ["max_concurrent", "signal"],
      ["max_concurrent", "interrupt"],
      ["async", "cancel", "concurrent"],
      ["async", "signal", "concurrent"],
    ],
    recipe: `### Skill: Concurrency + Signal Cleanup

**Purpose**: Verify that when \`n_tasks > max_concurrent\` and SIGINT is sent, only the tasks that actually started execute their cleanup/finally code.

**Recipe** — copy this script, adapt the 4 constants at the top, and run it:

\`\`\`python
#!/usr/bin/env python3
"""Skill test: SIGINT with queued tasks behind concurrency limit."""
import subprocess, signal, time, sys, os

# ===== ADAPT THESE to match the solution =====
SOLUTION_DIR  = "/app"          # directory containing the module
SOLUTION_MOD  = "run"           # Python module name (without .py)
SOLUTION_FUNC = "run_tasks"     # async function that accepts (tasks, max_concurrent)
# The function signature: async def <FUNC>(tasks: list[Callable], max_concurrent: int) -> None
# ==============================================

N_TASKS        = 5
MAX_CONCURRENT = 2

INNER = f"""
import asyncio, sys
sys.path.insert(0, "{SOLUTION_DIR}")
from {SOLUTION_MOD} import {SOLUTION_FUNC}

async def main():
    async def task(i):
        try:
            print(f"start:{{i}}", flush=True)
            await asyncio.sleep(30)
        finally:
            print(f"cleanup:{{i}}", flush=True)

    tasks = [lambda i=i: task(i) for i in range({N_TASKS})]
    await {SOLUTION_FUNC}(tasks, {MAX_CONCURRENT})

asyncio.run(main())
"""

inner_path = "/tmp/_skill_test_inner.py"
with open(inner_path, "w") as f:
    f.write(INNER)

proc = subprocess.Popen(
    [sys.executable, inner_path],
    stdout=subprocess.PIPE, stderr=subprocess.PIPE,
)

time.sleep(1.5)                      # let max_concurrent tasks start
proc.send_signal(signal.SIGINT)

try:
    stdout, stderr = proc.communicate(timeout=10)
except subprocess.TimeoutExpired:
    proc.kill()
    stdout, stderr = proc.communicate()

output = stdout.decode()
lines  = [l.strip() for l in output.strip().split("\\n") if l.strip()]
starts   = [l for l in lines if l.startswith("start:")]
cleanups = [l for l in lines if l.startswith("cleanup:")]

print(f"Lines  : {lines}")
print(f"Started: {len(starts)}  {starts}")
print(f"Cleaned: {len(cleanups)}  {cleanups}")

assert len(starts) == MAX_CONCURRENT, \\
    f"FAIL: expected {MAX_CONCURRENT} started, got {len(starts)}"
assert len(cleanups) == len(starts), \\
    f"FAIL: expected {len(starts)} cleanups (matching started), got {len(cleanups)}"

start_ids   = {s.split(':')[1] for s in starts}
cleanup_ids = {c.split(':')[1] for c in cleanups}
assert start_ids == cleanup_ids, \\
    f"FAIL: cleanup IDs {cleanup_ids} != start IDs {start_ids}"

print(f"PASS: {MAX_CONCURRENT}/{N_TASKS} started, all cleaned up on SIGINT")
os.remove(inner_path)
\`\`\`

**How to use**:
1. Read the solution source to identify SOLUTION_DIR, SOLUTION_MOD, SOLUTION_FUNC.
2. If the function signature differs (e.g. keyword argument \`max_concurrent\`), adjust the \`await\` call accordingly.
3. Write the script to a temp file, run it with \`python3 /tmp/_skill_concurrency_sigint.py\`.
4. If the assertion fails, report **FAIL** — this is a critical bug.`,
  },
];

// ── Skill detection ──────────────────────────────────────────

/**
 * Given a task description, return the skills whose trigger keywords match.
 * A skill matches when ANY of its trigger keyword-groups is fully satisfied.
 */
export function detectSkills(taskText: string): EvaluatorSkill[] {
  const lower = taskText.toLowerCase();
  return EVALUATOR_SKILLS.filter((skill) =>
    skill.triggers.some((group) => group.every((kw) => lower.includes(kw))),
  );
}
