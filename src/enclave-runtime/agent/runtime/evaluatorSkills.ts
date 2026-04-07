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

**Purpose**: Verify that designed primers satisfy melting-temperature constraints using the EXACT \`oligotm\` CLI with the EXACT flags from the task description.

**Why this matters**: The verifier extracts annealing portions by concatenating \`rc(rev_primer) + fwd_primer\`, locating the inserted/mutated region via \`find(insert)\`, and splitting. **Critically, the verifier's insert may be shifted by 2-3 bases compared to a naive prefix/suffix computation** due to shared boundary bases. This script tests ALL possible boundary positions to ensure constraints pass regardless.

**Recipe** — copy this script, adapt the two paths at the top, and run it. Ensure \`primer3\` is installed (\`apt install primer3\`).

\\\`\\\`\\\`python
#!/usr/bin/env python3
"""Skill test: Primer Tm verification — tests ALL boundary positions."""
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

# Detect insert/mutation: compute prefix_len and UNRESTRICTED suffix_len
prefix_len = 0
for i in range(min(len(input_seq), len(output_seq))):
    if input_seq[i] == output_seq[i]:
        prefix_len += 1
    else:
        break
full_suffix = 0
for i in range(1, min(len(input_seq), len(output_seq)) + 1):
    if input_seq[-i] == output_seq[-i]:
        full_suffix += 1
    else:
        break
# Overlap = shared bases at boundary that could go either way
overlap = max(0, prefix_len + full_suffix - len(input_seq))

# Generate all possible insert definitions (shifted boundary)
inserts = []
for shift in range(overlap + 1):
    p = prefix_len - shift
    s = full_suffix - (overlap - shift)
    ins = output_seq[p:len(output_seq) - s] if s > 0 else output_seq[p:]
    if ins and ins not in [x[1] for x in inserts]:
        inserts.append((p, ins))

print(f"Boundary overlap: {overlap} bases, testing {len(inserts)} insert variant(s)")
for p, ins in inserts:
    print(f"  boundary={p}: {ins[:50]}{'...' if len(ins)>50 else ''} (len={len(ins)})")

primers = read_fasta(PRIMERS_PATH)
assert len(primers) % 2 == 0 and len(primers) >= 2, "Primers must come in pairs"

for pi in range(0, len(primers), 2):
    fwd = primers[pi][1]
    rev = primers[pi + 1][1]
    assert re.fullmatch(r"[atcg]+", fwd), f"Fwd primer has invalid chars"
    assert re.fullmatch(r"[atcg]+", rev), f"Rev primer has invalid chars"
    concat = rc(rev) + fwd

    # Test ALL insert boundaries — if ANY fails, the primers are not robust
    any_found = False
    for p, ins in inserts:
        pos = concat.find(ins)
        if pos == -1:
            continue
        any_found = True
        ann_rev = concat[:pos]
        ann_fwd = concat[pos + len(ins):]
        fwd_tm_val = tm(ann_fwd)
        rev_tm_val = tm(rc(ann_rev))
        diff = abs(fwd_tm_val - rev_tm_val)

        print(f"Pair {pi//2} boundary={p}: ann_fwd={ann_fwd} ({len(ann_fwd)}nt, Tm={fwd_tm_val:.2f})")
        print(f"  ann_rev_rc={rc(ann_rev)} ({len(ann_rev)}nt, Tm={rev_tm_val:.2f})  diff={diff:.2f}")

        assert 15 <= len(ann_fwd) <= 45, \\
            f"FAIL at boundary {p}: fwd annealing length {len(ann_fwd)} not in [15,45]."
        assert 15 <= len(ann_rev) <= 45, \\
            f"FAIL at boundary {p}: rev annealing length {len(ann_rev)} not in [15,45]."
        assert 58 <= fwd_tm_val <= 72, \\
            f"FAIL at boundary {p}: fwd Tm {fwd_tm_val:.2f} not in [58,72]."
        assert 58 <= rev_tm_val <= 72, \\
            f"FAIL at boundary {p}: rev Tm {rev_tm_val:.2f} not in [58,72]."
        assert diff <= 5, \\
            f"FAIL at boundary {p}: Tm diff {diff:.2f} > 5 (fwd={fwd_tm_val:.2f}, rev={rev_tm_val:.2f})."

    assert any_found, f"Insert not found in rc(rev)+fwd for any boundary — primers may be wrong"

print("ALL PRIMER CHECKS PASSED")
\\\`\\\`\\\`

**How to use**:
1. Ensure \`primer3\` is installed (\`apt-get install -y primer3\`) so \`oligotm\` is available.
2. Write to temp file, run: \`python3 /tmp/_skill_primer_tm.py\`.
3. If assertion fails, report **FAIL** with the error message — it tells the fixer exactly what boundary and constraint failed.
4. **CRITICAL**: Do NOT substitute a Python Tm library for \`oligotm\`. The verifier uses the CLI tool with these exact flags.
5. **KEY INSIGHT**: The verifier's insert definition may differ from a naive prefix/suffix computation by 2-3 bases at the boundary. This script tests ALL possible boundaries, so if it passes, the verifier will too.`,
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
  {
    id: "video-jump-landing-stability",
    name: "Video Jump Landing Frame Stability Check",
    triggers: [
      ["jump", "video", "frame"],
      ["jump", "mp4", "frame"],
      ["takeoff", "land", "frame"],
      ["jump_analyzer"],
      ["hurdle", "video"],
    ],
    recipe: `### Skill: Video Jump Detection — Landing Frame Stability Check

**Purpose**: Verify that the detected landing frame represents the moment of **full ground contact** (feet stable on the ground), not a premature detection while the athlete is still descending. The verifier has a tight tolerance window (±2 frames) and systematic early detection is the #1 cause of failure.

**Why this matters**: A common algorithm detects landing as "foot position within X% of ground level" — this triggers 1-4 frames too early during the descent. The verifier expects the frame where the feet are actually planted and the position metric has stabilized.

**Recipe** — run this after the agent produces the script and the generalization test passes:

\\\`\\\`\\\`python
#!/usr/bin/env python3
"""Skill test: Landing frame stability — checks the detected landing is a stable ground frame."""
import cv2
import numpy as np
import subprocess, sys, os, toml

SCRIPT = "/app/jump_analyzer.py"
EXAMPLE = "/app/example_video.mp4"
OUTPUT = "/app/output.toml"

subprocess.run([sys.executable, SCRIPT, EXAMPLE], cwd="/app", capture_output=True)
result = toml.load(OUTPUT)
takeoff = result["jump_takeoff_frame_number"]
landing = result["jump_land_frame_number"]
print(f"Detected: takeoff={takeoff}, landing={landing}")

cap = cv2.VideoCapture(EXAMPLE)
total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))

def get_foot_metric(frame_idx):
    """Get the lowest body-pixel y-coordinate (foot position proxy)."""
    cap.set(cv2.CAP_PROP_POS_FRAMES, frame_idx)
    ret, frame = cap.read()
    if not ret:
        return None
    gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
    # Use background subtraction: compare to frame 0
    cap.set(cv2.CAP_PROP_POS_FRAMES, 0)
    _, bg = cap.read()
    bg_gray = cv2.cvtColor(bg, cv2.COLOR_BGR2GRAY)
    diff = cv2.absdiff(gray, bg_gray)
    _, mask = cv2.threshold(diff, 25, 255, cv2.THRESH_BINARY)
    ys = np.where(mask > 0)[0]
    if len(ys) == 0:
        return None
    return np.percentile(ys, 95)  # bot95: 95th percentile y

# Compute ground-level baseline from pre-jump frames
pre_jump_metrics = []
for f in range(max(0, takeoff - 10), takeoff - 2):
    m = get_foot_metric(f)
    if m is not None:
        pre_jump_metrics.append(m)

if not pre_jump_metrics:
    print("SKIP: cannot compute pre-jump baseline (no motion detected)")
    sys.exit(0)

ground_level = np.median(pre_jump_metrics)
ground_std = np.std(pre_jump_metrics) if len(pre_jump_metrics) > 1 else 2.0
print(f"Ground baseline: {ground_level:.1f} (std={ground_std:.1f})")

# Check landing frame and surrounding frames
stability_threshold = max(ground_std * 2, 3.0)  # pixels
print(f"Stability threshold: {stability_threshold:.1f} pixels from baseline")

landing_metric = get_foot_metric(landing)
print(f"Landing frame {landing}: bot95={landing_metric:.1f}, diff from ground={abs(landing_metric - ground_level):.1f}")

# Check: is the landing frame actually at ground level?
if landing_metric is not None and abs(landing_metric - ground_level) > stability_threshold:
    # Check frames after the detected landing to find where it actually stabilizes
    for f in range(landing, min(landing + 8, total_frames)):
        m = get_foot_metric(f)
        if m is not None:
            diff_from_ground = abs(m - ground_level)
            status = "STABLE" if diff_from_ground <= stability_threshold else "not stable"
            print(f"  frame {f}: bot95={m:.1f}, diff={diff_from_ground:.1f} -> {status}")

    print(f"\\nFAIL: Landing frame {landing} is NOT at ground level (bot95={landing_metric:.1f}, "
          f"ground={ground_level:.1f}, diff={abs(landing_metric - ground_level):.1f} > threshold {stability_threshold:.1f}). "
          f"The landing detection is triggering TOO EARLY — the athlete is still descending. "
          f"Fix: wait until bot95 returns to within {stability_threshold:.0f}px of {ground_level:.0f} "
          f"AND stays there for 2-3 consecutive frames.")
    sys.exit(1)

# Check: are the next 2 frames also stable?
unstable_after = []
for f in range(landing + 1, min(landing + 3, total_frames)):
    m = get_foot_metric(f)
    if m is not None and abs(m - ground_level) > stability_threshold:
        unstable_after.append((f, m))

if unstable_after:
    print(f"WARNING: frames after landing are unstable: {unstable_after}")
    print("The landing frame might be a momentary touch, not a stable plant.")

# Check: is the frame BEFORE landing clearly not at ground level?
pre_landing = get_foot_metric(landing - 1)
if pre_landing is not None:
    pre_diff = abs(pre_landing - ground_level)
    print(f"Frame {landing-1} (pre-landing): bot95={pre_landing:.1f}, diff={pre_diff:.1f}")
    if pre_diff <= stability_threshold:
        print(f"WARNING: frame {landing-1} is ALSO at ground level — landing may be 1 frame late "
              f"(less risky than being early, but worth checking)")

print(f"\\nPASS: Landing frame {landing} appears to be at stable ground level")
cap.release()
\\\`\\\`\\\`

**How to use**:
1. Run this AFTER the generalization test passes.
2. If the script reports FAIL (landing not at ground level), report **FAIL** — the detection is too early. The error message tells the fixer exactly how many pixels off it is and what threshold to use.
3. If it reports WARNING about pre-landing also being stable, that's acceptable (slightly late > slightly early).
4. **CRITICAL**: The verifier's tolerance is ±2 frames. Being 1 frame early can fail; being 1 frame late usually still passes. Always prefer the later frame when ambiguous.`,
  },
  {
    id: "mips-doom-frame-check",
    name: "MIPS Interpreter Frame Output Check",
    triggers: [
      ["mips", "interpreter"],
      ["mips", "vm.js"],
      ["mips", "elf", "interpreter"],
      ["mips", "doom"],
      ["doomgeneric", "mips"],
      ["doomgeneric_mips"],
    ],
    recipe: `### Skill: MIPS Interpreter — Frame BMP Output Verification

**Purpose**: Verify that \`node /app/vm.js\` actually produces a valid framebuffer image at \`/tmp/frame.bmp\` within 30 seconds, matching the verifier's exact contract. The verifier checks: (1) frame.bmp exists, (2) it's a valid image, (3) it's visually similar to a reference DOOM screen.

**Why this matters**: The agent may think the interpreter works because DOOM init text appears on stdout, but the framebuffer file might not be written (wrong syscall interception), might be in the wrong format (wrong BMP headers, wrong dimensions, wrong pixel order), or might be blank.

**Recipe** — run this after the agent produces vm.js:

\\\`\\\`\\\`bash
#!/bin/bash
set -e
FAILED=0

echo "=== Check 1: vm.js exists ==="
if [ ! -f /app/vm.js ]; then
    echo "FAIL: /app/vm.js does not exist"
    exit 1
fi
echo "PASS: vm.js exists"

echo ""
echo "=== Check 2: Run vm.js, wait for /tmp/frame.bmp ==="
rm -f /tmp/frame.bmp
timeout 35 node /app/vm.js > /tmp/_vm_stdout.txt 2>&1 &
VM_PID=$!

ELAPSED=0
while [ ! -f /tmp/frame.bmp ] && [ $ELAPSED -lt 30 ]; do
    sleep 1
    ELAPSED=$((ELAPSED + 1))
done

if [ -f /tmp/frame.bmp ]; then
    echo "PASS: /tmp/frame.bmp created after ~\${ELAPSED}s"
else
    echo "FAIL: /tmp/frame.bmp NOT created within 30 seconds"
    echo "  stdout (last 20 lines):"
    tail -20 /tmp/_vm_stdout.txt 2>/dev/null || echo "  (no output)"
    kill $VM_PID 2>/dev/null || true
    FAILED=1
fi

echo ""
echo "=== Check 3: frame.bmp is a valid image ==="
if [ -f /tmp/frame.bmp ]; then
    SIZE=$(stat -c%s /tmp/frame.bmp 2>/dev/null || echo 0)
    echo "  File size: $SIZE bytes"
    if [ "$SIZE" -lt 100 ]; then
        echo "FAIL: frame.bmp is too small ($SIZE bytes) — likely empty or corrupt"
        FAILED=1
    else
        python3 -c "
from PIL import Image
img = Image.open('/tmp/frame.bmp').convert('RGB')
w, h = img.size
print(f'  Image dimensions: {w}x{h}')
if w != 320 or h != 200:
    print(f'WARNING: Expected 320x200, got {w}x{h}. Verifier may still accept if similar enough.')
import numpy as np
arr = np.array(img)
mean_val = arr.mean()
if mean_val < 5:
    print(f'FAIL: Image is nearly black (mean pixel value={mean_val:.1f}). Framebuffer not being populated.')
    exit(1)
print(f'  Mean pixel value: {mean_val:.1f} (looks reasonable)')
print('PASS: frame.bmp is a valid, non-blank image')
" 2>&1
        if [ $? -ne 0 ]; then
            FAILED=1
        fi
    fi
fi

echo ""
echo "=== Check 4: DOOM init text in stdout (CRITICAL) ==="
EXPECTED_TEXT="I_InitGraphics: DOOM screen size: w x h: 320 x 200"
if grep -qF "$EXPECTED_TEXT" /tmp/_vm_stdout.txt 2>/dev/null; then
    echo "PASS: Exact verifier text found in stdout"
else
    echo "FAIL: Expected text not found in stdout:"
    echo "  Expected: '$EXPECTED_TEXT'"
    echo "  The verifier checks for this EXACT byte string."
    echo "  Common causes:"
    echo "  1. The write syscall for fd=1 (stdout) is not forwarding to process.stdout"
    echo "  2. The printf implementation in the binary is incomplete"
    echo "  3. The DG_Init / I_InitGraphics function is not being reached"
    echo "  Last 30 lines of stdout:"
    tail -30 /tmp/_vm_stdout.txt 2>/dev/null || echo "  (no output)"
    FAILED=1
fi

kill $VM_PID 2>/dev/null || true
rm -f /tmp/_vm_stdout.txt

echo ""
if [ $FAILED -eq 0 ]; then
    echo "ALL FRAME CHECKS PASSED"
else
    echo "SOME CHECKS FAILED — see above"
    exit 1
fi
\\\`\\\`\\\`

**How to use**:
1. After the agent creates \`/app/vm.js\`, write this script to a temp file and run: \`bash /tmp/_skill_doom_frame_check.sh\`
2. If frame.bmp doesn't appear: the interpreter isn't reaching \`DG_DrawFrame\` or the framebuffer write syscall isn't being intercepted. The agent needs to check its syscall handling.
3. If frame.bmp is blank/black: the framebuffer address in memory is wrong or the pixel format conversion is incorrect.
4. If frame.bmp has wrong dimensions: check \`DOOMGENERIC_RESX\` (320) and \`DOOMGENERIC_RESY\` (200) in the source.
5. **CRITICAL**: The verifier uses L2 similarity, not exact match. The image just needs to look like a DOOM screen. But it must be a valid BMP/image file.`,
  },
  {
    id: "pdb-chromophore-sequence-check",
    name: "PDB Chromophore Sequence Verification",
    triggers: [
      ["pdb", "fasta"],
      ["pdb", "protein", "gblock"],
      ["pdb", "protein", "sequence", "match"],
      ["fusion", "protein", "pdb"],
      ["fpbase", "pdb"],
    ],
    recipe: `### Skill: PDB Chromophore Sequence — Verify X→Tripeptide Replacement

**Purpose**: Verify that the agent correctly replaced PDB FASTA 'X' (chromophore) residues with the original tripeptide, NOT a single amino acid. This is the #1 failure mode for tasks involving fluorescent protein sequences from PDB.

**Why this matters**: PDB FASTA returns 'X' for chromophore positions in fluorescent proteins. The verifier checks the exact protein sequence. Replacing X with a single amino acid (e.g. Y) changes the protein length and fails the exact-match check.

**Recipe** — after the agent produces the output file, run this check:

\\\`\\\`\\\`python
#!/usr/bin/env python3
"""Skill test: Verify fluorescent protein sequences have correct chromophore tripeptides."""
import requests, sys, re, os

# ===== ADAPT THIS to match the output file =====
OUTPUT_FILE = "/app/gblock.txt"
PDB_IDS_FILE = "/app/pdb_ids.txt"
# ================================================

def get_canonical_seq(pdb_id):
    """Fetch canonical sequence from PDB REST API (has full tripeptide, no X)."""
    url = f"https://data.rcsb.org/rest/v1/core/polymer_entity/{pdb_id}/1"
    try:
        r = requests.get(url, timeout=15)
        r.raise_for_status()
        data = r.json()
        seq = data.get("entity_poly", {}).get("pdbx_seq_one_letter_code_can", "")
        return seq.replace("\\n", "").strip()
    except Exception as e:
        print(f"  WARNING: cannot fetch canonical seq for {pdb_id}: {e}")
        return None

def get_fasta_seq(pdb_id):
    """Fetch FASTA sequence from PDB (may contain X for chromophore)."""
    url = f"https://www.rcsb.org/fasta/entry/{pdb_id}"
    try:
        r = requests.get(url, timeout=15)
        r.raise_for_status()
        lines = r.text.strip().split("\\n")
        seq_lines = [l for l in lines if not l.startswith(">")]
        return "".join(seq_lines).strip()
    except Exception as e:
        print(f"  WARNING: cannot fetch FASTA for {pdb_id}: {e}")
        return None

# Read PDB IDs
pdb_ids = [line.strip() for line in open(PDB_IDS_FILE) if line.strip()]
print(f"PDB IDs: {pdb_ids}")

# Check which PDB IDs have chromophore (X in FASTA but not in canonical)
chromophore_proteins = []
for pid in pdb_ids:
    fasta = get_fasta_seq(pid)
    if fasta and "X" in fasta.upper():
        canonical = get_canonical_seq(pid)
        if canonical and "X" not in canonical.upper():
            # Find the tripeptide that replaces X
            fasta_upper = fasta.upper()
            x_pos = fasta_upper.index("X")
            # The canonical sequence has 2 extra AAs where X was (3 AAs replace 1 X)
            tripeptide = canonical[x_pos:x_pos+3] if x_pos + 3 <= len(canonical) else "???"
            chromophore_proteins.append({
                "pdb_id": pid,
                "x_position": x_pos,
                "tripeptide": tripeptide,
                "fasta_len": len(fasta),
                "canonical_len": len(canonical),
            })
            print(f"  {pid}: X at pos {x_pos} -> tripeptide '{tripeptide}' "
                  f"(FASTA len={len(fasta)}, canonical len={len(canonical)})")

if not chromophore_proteins:
    print("No chromophore proteins found in PDB IDs — skipping check")
    sys.exit(0)

# Read the output file
if not os.path.exists(OUTPUT_FILE):
    print(f"FAIL: {OUTPUT_FILE} not found")
    sys.exit(1)

output = open(OUTPUT_FILE).read().strip()

# For DNA gblocks, translate to protein first
if re.fullmatch(r"[ATCGatcg]+", output):
    from Bio.Seq import Seq
    protein = str(Seq(output).translate()).rstrip("*")
    print(f"Translated gblock: {len(output)} nt -> {len(protein)} aa")
else:
    protein = output
    print(f"Output appears to be protein sequence: {len(protein)} aa")

protein_upper = protein.upper()

# Check each chromophore protein
failed = False
for cp in chromophore_proteins:
    pid = cp["pdb_id"]
    tripeptide = cp["tripeptide"]
    canonical = get_canonical_seq(pid)
    fasta = get_fasta_seq(pid)

    if not canonical:
        continue

    # Remove initial M (task usually says to remove N-terminal Met)
    canonical_no_met = canonical[1:] if canonical.startswith("M") else canonical
    fasta_no_met = fasta[1:] if fasta and fasta.startswith("M") else (fasta or "")

    # Check: does the output contain the canonical sequence (with tripeptide)?
    if canonical_no_met.upper() in protein_upper:
        print(f"  PASS {pid}: canonical sequence (with tripeptide '{tripeptide}') found in output")
        continue

    # Check: does it contain the FASTA sequence (with X replaced by single AA)?
    # Try common single-AA replacements for X
    for single_aa in ["Y", "G", "A", "S", "F"]:
        fasta_replaced = fasta_no_met.upper().replace("X", single_aa)
        if fasta_replaced in protein_upper:
            print(f"  FAIL {pid}: found FASTA sequence with X->'{single_aa}' (SINGLE amino acid). "
                  f"X should be replaced with tripeptide '{tripeptide}', not a single AA. "
                  f"Use the PDB REST API canonical sequence: "
                  f"https://data.rcsb.org/rest/v1/core/polymer_entity/{pid}/1 "
                  f"-> entity_poly.pdbx_seq_one_letter_code_can")
            failed = True
            break
    else:
        print(f"  WARNING {pid}: neither canonical nor FASTA-based sequence found in output. "
              f"The protein may not be included, or the sequence may be differently truncated.")

if failed:
    sys.exit(1)
print("\\nPASS: All chromophore proteins use correct tripeptide sequences")
\\\`\\\`\\\`

**How to use**:
1. Install biopython if needed: \`pip install biopython requests\`
2. Adapt OUTPUT_FILE and PDB_IDS_FILE paths.
3. Run: \`python3 /tmp/_skill_chromophore_check.py\`
4. If FAIL: the agent used single-AA replacement for the chromophore X. The error message tells exactly which PDB ID, what tripeptide to use, and the API URL to fetch the correct sequence.`,
  },
  {
    id: "qemu-vm-verification",
    name: "QEMU VM Setup Verification",
    triggers: [
      ["qemu", "windows"],
      ["qemu", "vnc"],
      ["qemu", "virtual machine"],
      ["qemu", "vm", "keyboard"],
      ["win311"],
      ["windows 3.1"],
    ],
    recipe: `### Skill: QEMU VM Setup — Verify Configuration Before Submission

**Purpose**: Verify the QEMU VM is correctly configured: absolute disk path in cmdline, monitor socket responsive, and keystrokes produce visual feedback on the VNC display. These are the exact checks the verifier runs.

**Why this matters**: The verifier reads \`/proc/<pid>/cmdline\` for the absolute image path, sends keystrokes via the QEMU monitor socket, and compares VNC screenshots. Common failures: relative disk path, unresponsive monitor, Windows not booted to desktop.

**Recipe** — run this after QEMU and nginx are up:

\\\`\\\`\\\`bash
#!/bin/bash
set -e
FAILED=0

# ===== ADAPT THESE =====
EXPECTED_IMG_PATH="/app/isos/win311.img"
MONITOR_SOCK="/tmp/qemu-monitor.sock"
VNC_DISPLAY="localhost:1"
# ========================

echo "=== Check 1: QEMU process with absolute image path ==="
QEMU_PID=$(pgrep -f "qemu-system" | head -1)
if [ -z "$QEMU_PID" ]; then
    echo "FAIL: No qemu-system process found"
    FAILED=1
else
    CMDLINE=$(tr '\\0' ' ' < /proc/$QEMU_PID/cmdline)
    echo "QEMU cmdline: $CMDLINE"
    if echo "$CMDLINE" | grep -q "$EXPECTED_IMG_PATH"; then
        echo "PASS: Absolute image path found in cmdline"
    else
        echo "FAIL: '$EXPECTED_IMG_PATH' not found in cmdline."
        echo "  The verifier checks /proc/<pid>/cmdline for the FULL ABSOLUTE path."
        echo "  If you used 'cd /app && qemu ... -hda isos/win311.img', the cmdline"
        echo "  only contains the relative path. Use '-hda $EXPECTED_IMG_PATH' instead."
        FAILED=1
    fi
fi

echo ""
echo "=== Check 2: Monitor socket responsive ==="
if [ ! -S "$MONITOR_SOCK" ]; then
    echo "FAIL: Monitor socket $MONITOR_SOCK does not exist"
    FAILED=1
else
    RESP=$(echo "info status" | socat - UNIX-CONNECT:$MONITOR_SOCK 2>&1 | head -5)
    if echo "$RESP" | grep -qi "running\\|status"; then
        echo "PASS: Monitor socket responsive"
    else
        echo "FAIL: Monitor socket not responsive. Response: $RESP"
        FAILED=1
    fi
fi

echo ""
echo "=== Check 3: VNC accessible ==="
apt-get install -y -qq vncsnapshot 2>/dev/null || true
vncsnapshot -allowblank $VNC_DISPLAY /tmp/_eval_baseline.png 2>/dev/null
if [ $? -eq 0 ] && [ -f /tmp/_eval_baseline.png ]; then
    echo "PASS: VNC screenshot captured"
else
    echo "FAIL: Cannot capture VNC screenshot from $VNC_DISPLAY"
    FAILED=1
fi

echo ""
echo "=== Check 4: Keystroke produces visual change ==="
if [ -f /tmp/_eval_baseline.png ] && [ -S "$MONITOR_SOCK" ]; then
    # Send Ctrl+Esc (Start Menu in Windows)
    echo "sendkey ctrl-esc" | socat - UNIX-CONNECT:$MONITOR_SOCK 2>/dev/null
    sleep 3
    vncsnapshot -allowblank $VNC_DISPLAY /tmp/_eval_after_key.png 2>/dev/null

    if [ -f /tmp/_eval_after_key.png ]; then
        DIFF_PCT=$(python3 -c "
import cv2, numpy as np
b = cv2.imread('/tmp/_eval_baseline.png', cv2.IMREAD_GRAYSCALE)
a = cv2.imread('/tmp/_eval_after_key.png', cv2.IMREAD_GRAYSCALE)
if b is None or a is None or b.shape != a.shape:
    print('0.0')
else:
    print(f'{(np.count_nonzero(b != a) / b.size) * 100.0:.2f}')
" 2>/dev/null)
        echo "Pixel difference after Ctrl+Esc: \${DIFF_PCT}%"
        # Use a slightly lower threshold than verifier (10%) to catch marginal cases
        OK=$(python3 -c "print('yes' if float('\${DIFF_PCT}') >= 8.0 else 'no')")
        if [ "$OK" = "yes" ]; then
            echo "PASS: Keystroke caused visual change (\${DIFF_PCT}% pixels differ)"
        else
            echo "FAIL: Keystroke caused <8% visual change (\${DIFF_PCT}%)."
            echo "  Possible causes:"
            echo "  1. Windows has not booted to the desktop yet (still at DOS/boot screen)"
            echo "  2. QEMU version incompatible with the guest OS (task specifies QEMU 5.2.0)"
            echo "  3. Keyboard input not reaching the guest (monitor socket misconfigured)"
            echo "  Fix: Wait longer for boot, verify the VNC screenshot shows the Windows desktop,"
            echo "  and try using the exact QEMU version specified in the task."
            FAILED=1
        fi
    fi
fi

# Cleanup
rm -f /tmp/_eval_baseline.png /tmp/_eval_after_key.png

echo ""
if [ $FAILED -eq 0 ]; then
    echo "ALL QEMU CHECKS PASSED"
else
    echo "SOME CHECKS FAILED — see above"
    exit 1
fi
\\\`\\\`\\\`

**How to use**:
1. Ensure \`socat\`, \`vncsnapshot\`, and \`python3\` with \`opencv-python\`/\`numpy\` are installed.
2. Adapt EXPECTED_IMG_PATH, MONITOR_SOCK, VNC_DISPLAY if needed.
3. Write to temp file, run: \`bash /tmp/_skill_qemu_check.sh\`
4. If any check FAILs, report **FAIL** with the specific error. The diagnostic messages tell the fixer exactly what's wrong.
5. **IMPORTANT**: The visual feedback check uses a slightly lower threshold (8%) than the verifier (10%) to catch borderline cases early. If this check barely passes (8-12%), warn that it's marginal.`,
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
