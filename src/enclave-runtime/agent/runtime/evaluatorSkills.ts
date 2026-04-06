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

**Purpose**: Verify that when \`n_tasks > max_concurrent\` and SIGINT is sent externally, the started tasks' cleanup/finally code ACTUALLY RUNS — including any \`await\` inside the \`finally\` block.

**Why this matters**: When a task is cancelled via \`task.cancel()\`, asyncio sets an internal \`_must_cancel\` flag. The \`CancelledError\` is thrown at the current \`await\`, and the \`finally\` block begins. BUT \`_must_cancel\` is still True — so any \`await\` INSIDE the \`finally\` block gets immediately cancelled too, and code after that \`await\` never runs. A correct implementation must protect cleanup from re-cancellation (e.g. using \`asyncio.shield()\`, \`task.uncancel()\`, or a signal-handler-based approach instead of \`task.cancel()\`).

**Recipe** — copy this script, adapt the 4 constants at the top, and run it:

\`\`\`python
#!/usr/bin/env python3
"""Skill test: SIGINT with queued tasks — verifies cleanup OUTPUT is visible."""
import subprocess, signal, time, sys, os

# ===== ADAPT THESE to match the solution =====
SOLUTION_DIR  = "/app"          # directory containing the module
SOLUTION_MOD  = "run"           # Python module name (without .py)
SOLUTION_FUNC = "run_tasks"     # async function that accepts (tasks, max_concurrent)
# The function signature: async def <FUNC>(tasks: list[Callable], max_concurrent: int) -> None
# ==============================================

N_TASKS        = 5
MAX_CONCURRENT = 2

# IMPORTANT: The finally block contains an await before the cleanup print.
# This is critical because when a task is cancelled, _must_cancel is still True
# when the finally block runs, so any await in the finally block gets cancelled
# immediately unless the implementation handles this (e.g. via task.uncancel() or
# asyncio.shield). A naive implementation will silently skip the cleanup print.
INNER = f"""
import asyncio, sys
sys.path.insert(0, "{SOLUTION_DIR}")
from {SOLUTION_MOD} import {SOLUTION_FUNC}

async def main():
    async def task(i):
        try:
            print(f"start:{{i}}")
            await asyncio.sleep(30)
        finally:
            await asyncio.sleep(0.5)
            print(f"cleanup:{{i}}")

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
print(f"Exit code: {proc.returncode}")

assert len(starts) == MAX_CONCURRENT, \\
    f"FAIL: expected {MAX_CONCURRENT} started, got {len(starts)}"
assert len(cleanups) == len(starts), \\
    f"FAIL: expected {len(starts)} cleanups (matching started), got {len(cleanups)}. " \\
    f"If 0 cleanups: the finally block's await was re-cancelled. " \\
    f"When task.cancel() is used, _must_cancel stays True in the finally block, " \\
    f"so any await in finally gets immediately cancelled. " \\
    f"Fix: use asyncio.shield() to protect cleanup awaits, or task.uncancel() before cleanup, " \\
    f"or avoid task.cancel() entirely (use a signal handler + Event to request graceful shutdown)."

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
4. If the assertion fails, report **FAIL** — this is a critical bug. Include the assertion message in your report — it contains diagnostic hints for the fixer.`,
  },
  {
    id: "primer-design-tm",
    name: "Primer Design Tm Verification",
    triggers: [
      ["primer", "melting"],
      ["primer", "oligotm"],
      ["primer", "mutagenesis"],
      ["primer", "anneal"],
      ["primer", "temperature"],
      ["oligotm"],
    ],
    recipe: `### Skill: Primer Design — Tm Verification with oligotm

**Purpose**: Verify that designed primers satisfy melting-temperature constraints using the EXACT \`oligotm\` CLI with the EXACT flags from the task description. The most common failure mode is computing Tm with a Python library or with wrong flags — the values will be close but not identical to the verifier.

**Why this matters**: The verifier extracts annealing portions by concatenating \`rc(rev_primer) + fwd_primer\`, locating the inserted/mutated region in the concatenation, and splitting. It then calls \`oligotm\` (from the \`primer3\` package) with specific flags on these portions. Even a 0.5 degree difference can cause a marginal fail.

**Recipe** — copy this script, adapt the two paths at the top, and run it. Ensure \`primer3\` is installed (\`apt install primer3\`).

\\\`\\\`\\\`python
#!/usr/bin/env python3
"""Skill test: Primer Tm verification — mirrors verifier logic exactly."""
import subprocess, sys, os, re

PRIMERS_PATH = "/app/primers.fasta"
SEQUENCES_PATH = "/app/sequences.fasta"

def read_fasta(path):
    seqs = []
    name, parts = None, []
    with open(path) as f:
        for line in f:
            line = line.strip()
            if line.startswith(">"):
                if name is not None:
                    seqs.append((name, "".join(parts).lower()))
                name = line[1:].strip()
                parts = []
            else:
                parts.append(line)
    if name is not None:
        seqs.append((name, "".join(parts).lower()))
    return seqs

def rc(seq):
    comp = {"a": "t", "t": "a", "c": "g", "g": "c"}
    return "".join(comp[b] for b in reversed(seq))

def tm(seq):
    r = subprocess.run(
        ["oligotm", "-tp", "1", "-sc", "1", "-mv", "50",
         "-dv", "2", "-n", "0.8", "-d", "500", seq],
        capture_output=True, text=True,
    )
    assert r.returncode == 0, f"oligotm failed: {r.stderr}"
    return float(r.stdout.strip())

assert os.path.exists(PRIMERS_PATH), f"{PRIMERS_PATH} not found"
assert os.path.exists(SEQUENCES_PATH), f"{SEQUENCES_PATH} not found"

seqs = read_fasta(SEQUENCES_PATH)
assert len(seqs) >= 2, f"Need >= 2 sequences in {SEQUENCES_PATH}"
input_seq = seqs[0][1]
output_seq = seqs[1][1]

# Detect insert/mutation by comparing input and output
prefix_len = 0
for i in range(min(len(input_seq), len(output_seq))):
    if input_seq[i] == output_seq[i]:
        prefix_len += 1
    else:
        break
suffix_len = 0
max_sfx = min(len(input_seq), len(output_seq)) - prefix_len
for i in range(1, max_sfx + 1):
    if input_seq[-i] == output_seq[-i]:
        suffix_len += 1
    else:
        break
insert = output_seq[prefix_len:len(output_seq) - suffix_len] if suffix_len > 0 else output_seq[prefix_len:]
print(f"Detected insert/mutation: {insert[:60]}{'...' if len(insert)>60 else ''} (len={len(insert)})")

primers = read_fasta(PRIMERS_PATH)
assert len(primers) % 2 == 0 and len(primers) >= 2, "Primers must come in pairs"

for pi in range(0, len(primers), 2):
    fwd = primers[pi][1]
    rev = primers[pi + 1][1]
    assert re.fullmatch(r"[atcg]+", fwd), f"Fwd primer has invalid chars"
    assert re.fullmatch(r"[atcg]+", rev), f"Rev primer has invalid chars"

    # Verifier method: rc(rev) + fwd, locate insert, split into annealing portions
    concat = rc(rev) + fwd
    pos = concat.find(insert)
    assert pos != -1, f"Insert not found in rc(rev)+fwd — primers may be wrong"
    ann_rev = concat[:pos]
    ann_fwd = concat[pos + len(insert):]

    print(f"Pair {pi//2}: ann_fwd={ann_fwd} ({len(ann_fwd)} nt)")
    print(f"         ann_rev={ann_rev} ({len(ann_rev)} nt)")

    assert 15 <= len(ann_fwd) <= 45, \\
        f"FAIL: fwd annealing length {len(ann_fwd)} not in [15,45]. Adjust primer."
    assert 15 <= len(ann_rev) <= 45, \\
        f"FAIL: rev annealing length {len(ann_rev)} not in [15,45]. Adjust primer."

    fwd_tm = tm(ann_fwd)
    rev_tm = tm(rc(ann_rev))
    diff = abs(fwd_tm - rev_tm)
    print(f"  fwd_tm={fwd_tm:.2f}  rev_tm={rev_tm:.2f}  diff={diff:.2f}")

    assert 58 <= fwd_tm <= 72, \\
        f"FAIL: fwd Tm {fwd_tm:.2f} not in [58,72]. Shorten or lengthen fwd annealing portion."
    assert 58 <= rev_tm <= 72, \\
        f"FAIL: rev Tm {rev_tm:.2f} not in [58,72]. Shorten or lengthen rev annealing portion."
    assert diff <= 5, \\
        f"FAIL: Tm diff {diff:.2f} > 5 (fwd={fwd_tm:.2f}, rev={rev_tm:.2f}). " \\
        f"Adjust annealing lengths so both Tms are within 5 degrees of each other."

print("ALL PRIMER CHECKS PASSED")
\\\`\\\`\\\`

**How to use**:
1. Ensure \`primer3\` is installed (\`apt-get install -y primer3\`) so \`oligotm\` is available.
2. Adapt PRIMERS_PATH / SEQUENCES_PATH if needed.
3. Write to temp file, run: \`python3 /tmp/_skill_primer_tm.py\`.
4. If assertion fails, report **FAIL** with the error message — it tells the fixer exactly what needs adjusting.
5. **CRITICAL**: Do NOT substitute a Python Tm library for \`oligotm\`. The verifier uses the CLI tool with these exact flags. Even small differences in Tm calculation method will cause failures.`,
  },
  {
    id: "elf-memory-extraction",
    name: "ELF Binary Memory Extraction",
    triggers: [
      ["extract", "elf"],
      ["extract", "binary", "memory"],
      ["extract", "a.out", "memory"],
      ["extract.js", "binary"],
      ["extract.js", "a.out"],
    ],
    recipe: `### Skill: ELF Memory Extraction — unsigned integer check

**Purpose**: Verify that extracted memory values from an ELF binary are **unsigned** 32-bit integers. The most common bug is using signed reads (\`readInt32LE\`) instead of unsigned reads (\`readUInt32LE\`), which produces negative values for any word with the high bit set.

**Why this matters**: The verifier compiles a NEW binary (not the provided \`a.out\`) and compares your script's output against a reference. If your script outputs signed values (negative numbers), every address with a high-bit-set value will mismatch.

**Recipe** — run this check after the agent produces \`extract.js\`:

\\\`\\\`\\\`bash
#!/bin/bash
# Quick check: run extract.js on the provided binary, look for negative values
cd /app
node extract.js a.out > /tmp/_elf_check.json 2>/dev/null

# Count negative values in JSON output
NEGATIVES=$(python3 -c "
import json, sys
with open('/tmp/_elf_check.json') as f:
    data = json.load(f)
negs = {k: v for k, v in data.items() if isinstance(v, (int, float)) and v < 0}
print(len(negs))
if negs:
    sample = dict(list(negs.items())[:5])
    print(f'Sample negative values: {sample}', file=sys.stderr)
    print(f'These are signed 32-bit reads. Use readUInt32LE (unsigned) instead of readInt32LE (signed).', file=sys.stderr)
    sys.exit(1)
")

if [ $? -ne 0 ]; then
    echo "FAIL: Found negative values in output — using signed int reads instead of unsigned"
    exit 1
fi
echo "PASS: All values are non-negative (unsigned)"
\\\`\\\`\\\`

**How to use**:
1. After the agent creates \`/app/extract.js\`, run the check script above.
2. If it reports negative values, report **FAIL** — the script is using \`readInt32LE\` or \`DataView.getInt32\` instead of the unsigned variants (\`readUInt32LE\` / \`getUint32\`).
3. Also verify the output is valid JSON with numeric (not string) values.`,
  },
  {
    id: "video-jump-detection",
    name: "Video Jump Detection Generalization",
    triggers: [
      ["jump", "video", "frame"],
      ["jump", "mp4", "frame"],
      ["takeoff", "land", "frame"],
      ["jump_analyzer"],
      ["hurdle", "video"],
    ],
    recipe: `### Skill: Video Jump Detection — Generalization Test

**Purpose**: Verify that a jump detection script generalizes to videos where the jump happens at DIFFERENT frame numbers, not just the example video. The most common failure is overfitting to the example video's timing.

**Why this matters**: The verifier tests on a HIDDEN video where the jump happens at a completely different frame number (e.g. frame 220 instead of 53). A script that hardcodes thresholds or frame ranges based on the example will fail.

**Recipe** — after the agent produces the script, run this generalization test:

\\\`\\\`\\\`python
#!/usr/bin/env python3
"""Skill test: Jump detection generalization via time-shifted video."""
import cv2
import numpy as np
import subprocess, sys, os, toml

SCRIPT = "/app/jump_analyzer.py"
EXAMPLE = "/app/example_video.mp4"
OUTPUT = "/app/output.toml"
SHIFTED = "/tmp/_shifted_video.mp4"

# Step 1: run on example video to get baseline
subprocess.run([sys.executable, SCRIPT, EXAMPLE], cwd="/app", capture_output=True)
baseline = toml.load(OUTPUT)
base_takeoff = baseline["jump_takeoff_frame_number"]
base_landing = baseline["jump_land_frame_number"]
print(f"Baseline: takeoff={base_takeoff}, landing={base_landing}")

# Step 2: create a time-shifted video by prepending N static frames
cap = cv2.VideoCapture(EXAMPLE)
fps = cap.get(cv2.CAP_PROP_FPS)
w = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
h = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
ret, first_frame = cap.read()
assert ret, "Cannot read example video"

N_PREPEND = 150
fourcc = cv2.VideoWriter_fourcc(*"mp4v")
out = cv2.VideoWriter(SHIFTED, fourcc, fps, (w, h))
for _ in range(N_PREPEND):
    out.write(first_frame)

cap.set(cv2.CAP_PROP_POS_FRAMES, 0)
while True:
    ret, frame = cap.read()
    if not ret:
        break
    out.write(frame)
out.release()
cap.release()

# Step 3: run on shifted video
subprocess.run([sys.executable, SCRIPT, SHIFTED], cwd="/app", capture_output=True)
shifted = toml.load(OUTPUT)
shifted_takeoff = shifted["jump_takeoff_frame_number"]
shifted_landing = shifted["jump_land_frame_number"]
print(f"Shifted: takeoff={shifted_takeoff}, landing={shifted_landing}")
print(f"Expected: takeoff~{base_takeoff + N_PREPEND}, landing~{base_landing + N_PREPEND}")

# Step 4: verify the shift is reflected (tolerance of +/-5 frames)
TOLERANCE = 5
expected_takeoff = base_takeoff + N_PREPEND
expected_landing = base_landing + N_PREPEND

assert abs(shifted_takeoff - expected_takeoff) <= TOLERANCE, \\
    f"FAIL: shifted takeoff={shifted_takeoff}, expected ~{expected_takeoff} (base {base_takeoff} + {N_PREPEND}). " \\
    f"The detection algorithm does not generalize — it likely uses absolute frame thresholds " \\
    f"or position heuristics that only work on the example video. " \\
    f"Fix: use relative motion/change detection rather than absolute frame positions."

assert abs(shifted_landing - expected_landing) <= TOLERANCE, \\
    f"FAIL: shifted landing={shifted_landing}, expected ~{expected_landing}. " \\
    f"Same issue as takeoff — algorithm does not generalize."

print("PASS: Jump detection generalizes correctly to time-shifted video")
os.remove(SHIFTED)
\\\`\\\`\\\`

**How to use**:
1. After the agent creates \`/app/jump_analyzer.py\` and it passes on the example video, run this script.
2. It prepends 150 static frames to the example, creating a shifted video where the jump happens ~150 frames later.
3. If the detection doesn't shift accordingly, the algorithm is overfitting to the example.
4. Report **FAIL** with the assertion message — it tells the fixer to use relative motion detection.`,
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
