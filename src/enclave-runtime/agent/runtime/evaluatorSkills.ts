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
    recipe: `### Skill: Video Jump Detection — Hurdle-Anchored Detection Test

**Purpose**: Verify that the jump detection uses the HURDLE POSITION as the anchor point, not just "largest vertical displacement" or "first motion." The hidden test video has 200+ frames of running before the actual hurdle jump, and any algorithm that doesn't anchor to the hurdle will detect the wrong event.

**Why this matters**: Algorithms that work on the short example video (120 frames, jump at ~53) often fail on the test video (~270 frames, jump at ~220) because they detect running strides, athlete entry, or other motion as "the jump." The hurdle is at a FIXED position in all videos — the correct algorithm must use it.

**Recipe** — this test verifies the algorithm is hurdle-anchored by creating a video with a FAKE vertical displacement event before the real jump:

\\\`\\\`\\\`python
#!/usr/bin/env python3
"""Skill test: Verify jump detection is anchored to the hurdle position, not just vertical motion."""
import cv2
import numpy as np
import subprocess, sys, os, toml

SCRIPT = "/app/jump_analyzer.py"
EXAMPLE = "/app/example_video.mp4"
OUTPUT = "/app/output.toml"
TRICKY = "/tmp/_tricky_video.mp4"

# Step 1: get baseline
r = subprocess.run([sys.executable, SCRIPT, EXAMPLE], cwd="/app", capture_output=True, text=True)
assert r.returncode == 0, f"Baseline failed: {r.stderr[-300:]}"
baseline = toml.load(OUTPUT)
base_takeoff = baseline["jump_takeoff_frame_number"]
base_landing = baseline["jump_land_frame_number"]
print(f"Baseline: takeoff={base_takeoff}, landing={base_landing}")

# Step 2: read all frames
cap = cv2.VideoCapture(EXAMPLE)
fps = cap.get(cv2.CAP_PROP_FPS)
w, h = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH)), int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
all_frames = []
while True:
    ret, frame = cap.read()
    if not ret: break
    all_frames.append(frame)
cap.release()
bg = all_frames[0].copy()

# Step 3: create tricky video with a FAKE jump-like event first
# Inject 60 frames of a fake "moving blob" in a different part of the frame,
# then 30 static background frames, then the real video.
fourcc = cv2.VideoWriter_fourcc(*"mp4v")
out = cv2.VideoWriter(TRICKY, fourcc, fps, (w, h))

# 60 frames: a white rectangle bounces vertically in the RIGHT side of the frame
# (far from the hurdle, which is typically at x~500-700)
for i in range(60):
    f = bg.copy()
    y_pos = 200 + int(80 * np.sin(i * 0.3))
    cv2.rectangle(f, (850, y_pos), (920, y_pos + 80), (255, 255, 255), -1)
    out.write(f)

# 30 static background frames (gap)
for _ in range(30):
    out.write(bg)

# All original frames
for f in all_frames:
    out.write(f)
out.release()

n_prepend = 90  # 60 fake + 30 gap
expected_takeoff = base_takeoff + n_prepend
expected_landing = base_landing + n_prepend
print(f"Tricky video: {n_prepend} prepended frames (fake blob + gap)")
print(f"Expected: takeoff~{expected_takeoff}, landing~{expected_landing}")

# Step 4: run on tricky video
r = subprocess.run([sys.executable, SCRIPT, TRICKY], cwd="/app", capture_output=True, text=True)
if r.returncode != 0:
    print(f"FAIL: script crashed on tricky video: {r.stderr[-300:]}")
    print("Fix: ensure the script never crashes. Use try/except and fallback logic.")
    os.remove(TRICKY)
    sys.exit(1)

result = toml.load(OUTPUT)
t, l = result["jump_takeoff_frame_number"], result["jump_land_frame_number"]
print(f"Detected: takeoff={t}, landing={l}")

TOLERANCE = 5
takeoff_err = abs(t - expected_takeoff)

if takeoff_err > TOLERANCE:
    print(f"FAIL: takeoff={t}, expected ~{expected_takeoff} (off by {takeoff_err} frames). "
          f"The algorithm detected the FAKE motion blob instead of the real hurdle jump. "
          f"This means it is NOT anchored to the hurdle position. "
          f"Fix: detect the hurdle's x-position from frame 0 (fixed vertical edges in the track region). "
          f"Only look for the jump when the athlete's center-x is near the hurdle. "
          f"The hurdle position is the SAME in all videos.")
    os.remove(TRICKY)
    sys.exit(1)

landing_err = abs(l - expected_landing)
if landing_err > TOLERANCE:
    print(f"FAIL: landing={l}, expected ~{expected_landing} (off by {landing_err}).")
    os.remove(TRICKY)
    sys.exit(1)

print("PASS: Script correctly ignores fake motion and finds the real hurdle jump")
os.remove(TRICKY)
\\\`\\\`\\\`

**How to use**:
1. This is the MOST IMPORTANT test — run it FIRST. It catches algorithms that trigger on any vertical motion rather than the hurdle jump specifically.
2. It inserts a fake bouncing blob AWAY from the hurdle location, then the real video. If the algorithm reports an early takeoff, it's not hurdle-anchored.
3. The FAIL message tells the fixer to use the hurdle's x-position as the detection anchor.
4. **Key insight for the fixer**: the hurdle is at a fixed x-position (same in all videos). Detect it from frame 0 and only analyze vertical displacement near it.`,
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
    id: "video-jump-robustness",
    name: "Video Jump Detection Robustness Check",
    triggers: [
      ["jump", "video", "frame"],
      ["jump", "mp4", "frame"],
      ["takeoff", "land", "frame"],
      ["jump_analyzer"],
      ["hurdle", "video"],
    ],
    recipe: `### Skill: Video Jump Detection — Robustness to Unseen Videos

**Purpose**: Verify that \`jump_analyzer.py\` doesn't crash on videos with different visual characteristics (different athlete appearance, brightness, contrast). The most common failure is \`ValueError: Could not detect athlete in video\` because thresholds are tuned too tightly to the example.

**Why this matters**: The verifier runs the script on a HIDDEN test video with a different athlete (different clothing, body shape). If the detection parameters are too specific to the example video's visual properties, the script will crash or fail to detect anyone.

**Recipe** — run this to test robustness with altered videos:

\\\`\\\`\\\`python
#!/usr/bin/env python3
"""Skill test: Detection robustness — test with brightness/contrast perturbations."""
import cv2
import numpy as np
import subprocess, sys, os, toml

SCRIPT = "/app/jump_analyzer.py"
EXAMPLE = "/app/example_video.mp4"
OUTPUT = "/app/output.toml"

# Get baseline result
r = subprocess.run([sys.executable, SCRIPT, EXAMPLE], cwd="/app", capture_output=True, text=True)
assert r.returncode == 0, f"Script fails on example video: {r.stderr[-500:]}"
baseline = toml.load(OUTPUT)
base_t = baseline["jump_takeoff_frame_number"]
base_l = baseline["jump_land_frame_number"]
print(f"Baseline: takeoff={base_t}, landing={base_l}")

def make_perturbed_video(out_path, transform_fn):
    cap = cv2.VideoCapture(EXAMPLE)
    fps = cap.get(cv2.CAP_PROP_FPS)
    w, h = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH)), int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    fourcc = cv2.VideoWriter_fourcc(*"mp4v")
    writer = cv2.VideoWriter(out_path, fourcc, fps, (w, h))
    while True:
        ret, frame = cap.read()
        if not ret:
            break
        writer.write(transform_fn(frame))
    writer.release()
    cap.release()

tests = [
    ("bright+40", lambda f: np.clip(f.astype(np.int16) + 40, 0, 255).astype(np.uint8)),
    ("bright-40", lambda f: np.clip(f.astype(np.int16) - 40, 0, 255).astype(np.uint8)),
    ("low_contrast", lambda f: np.clip(((f.astype(np.float32) - 128) * 0.5 + 128), 0, 255).astype(np.uint8)),
]

for name, fn in tests:
    path = f"/tmp/_perturbed_{name}.mp4"
    make_perturbed_video(path, fn)
    r = subprocess.run([sys.executable, SCRIPT, path], cwd="/app", capture_output=True, text=True)
    if r.returncode != 0:
        print(f"FAIL [{name}]: script crashed: {r.stderr[-300:]}")
        print(f"The detection is NOT robust to {name}. It will likely fail on the hidden test video.")
        print(f"Fix: use adaptive/multi-threshold detection. Try multiple background subtraction thresholds "
              f"and pick the one that gives the best signal. Never crash — always produce output.")
        os.remove(path)
        sys.exit(1)
    result = toml.load(OUTPUT)
    t, l = result["jump_takeoff_frame_number"], result["jump_land_frame_number"]
    t_ok = abs(t - base_t) <= 3
    l_ok = abs(l - base_l) <= 3
    print(f"  [{name}] takeoff={t} (diff={t-base_t}), landing={l} (diff={l-base_l}) -> {'PASS' if t_ok and l_ok else 'WARN'}")
    os.remove(path)

print("PASS: Script is robust to brightness/contrast perturbations")
\\\`\\\`\\\`

**How to use**:
1. Run this BEFORE the other jump detection skill tests. If the script crashes on perturbed videos, it will almost certainly crash on the hidden test video.
2. If FAIL: report with the crash message. The fixer needs to make detection more robust (multi-threshold, adaptive, never crash).
3. WARN results (frame off by 1-3) are acceptable — the key is that the script doesn't crash.`,
  },
  {
    id: "html-sanitization-xss-vectors",
    name: "HTML XSS Sanitization — XSS Vector + Clean HTML Verification",
    triggers: [
      ["filter", "javascript", "html"],
      ["filter", "js", "html"],
      ["sanitize", "html", "script"],
      ["remove", "script", "html"],
      ["strip", "javascript", "html"],
      ["remove", "javascript", "xss"],
      ["xss", "html", "filter"],
    ],
    recipe: `### Skill: HTML XSS Filter — XSS Vectors + Dependency Safety Check

## CRITICAL — Dependency check (this is the #1 cause of failure)

The verifier runs \`/app/filter.py\` in a **separate Docker container** that shares \`/app\` but NOT the agent's Python environment. In this verifier container, \`pip install bleach\` **FAILS** (non-zero exit). Any solution that imports bleach WILL crash with \`ModuleNotFoundError\` in the verifier, causing all 12 clean HTML tests to fail.

**Check FIRST**: Does filter.py import bleach, lxml, or html5lib?
\`\`\`bash
grep -i 'import bleach\\|import lxml\\|import html5lib' /app/filter.py
\`\`\`
If YES → **immediate FAIL**. The fix is to rewrite using only \`beautifulsoup4\` (which IS installable in the verifier container) with manual DOM-walk sanitization.

Only \`beautifulsoup4\` is safe to depend on. The solution must auto-install it:
\`\`\`python
try:
    from bs4 import BeautifulSoup
except ImportError:
    subprocess.check_call([sys.executable, "-m", "pip", "install", "-q", "beautifulsoup4"])
    from bs4 import BeautifulSoup
\`\`\`

## Recipe — run these checks, then report verdict

\\\`\\\`\\\`python
#!/usr/bin/env python3
"""Skill test: dependency safety + XSS vectors + clean HTML semantic preservation."""
import subprocess, sys, tempfile, os
from pathlib import Path

FILTER_SCRIPT = "/app/filter.py"

def run_filter_inplace(html_input):
    tf = tempfile.NamedTemporaryFile("w", suffix=".html", delete=False, encoding="utf-8")
    tf.write(html_input)
    tf.close()
    r = subprocess.run([sys.executable, FILTER_SCRIPT, tf.name],
                       capture_output=True, text=True, timeout=15)
    if r.returncode != 0:
        os.unlink(tf.name)
        return None, r.stderr
    result = Path(tf.name).read_text()
    os.unlink(tf.name)
    return result, None

# Check 1: dependency safety
with open(FILTER_SCRIPT) as f:
    source = f.read()
for lib in ['bleach', 'lxml', 'html5lib']:
    if f'import {lib}' in source:
        print(f"FAIL: filter.py imports '{lib}' which is NOT available in the verifier container")
        print("The verifier runs in a separate Docker container where pip install bleach FAILS.")
        print("Solution MUST use only beautifulsoup4 for HTML parsing.")
        sys.exit(1)
print("PASS: no dangerous imports (bleach/lxml/html5lib)")

# Check 2: XSS vectors
xss_vectors = [
    ('<p>hi</p><script>alert(1)</script><p>bye</p>', 'script'),
    ('<img src=x onerror=alert(2)>', 'onerror'),
    ('<a href="javascript:alert(3)">click</a>', 'javascript:'),
    ('<img src="data:text/html,<script>alert(4)</script>">', 'data:text/html'),
    ('<object><param name="src" value="javascript:alert(5)"></object>', 'javascript:'),
    ('<div style="width:expression(alert(6))">x</div>', 'expression'),
    ('<iframe src="javascript:alert(7)"></iframe>', 'iframe'),
    ('<embed src="data:text/html,<script>alert(8)</script>">', 'embed'),
    ('<svg onload=alert(9)></svg>', 'onload'),
    ('<link rel="stylesheet" href="javascript:alert(13)">', 'javascript:'),
    ('<meta http-equiv="refresh" content="0;url=javascript:alert(14)">', 'javascript:'),
    ('<base href="javascript:alert(15)">', 'base'),
    ('<div oonmouseover=nmouseover=alert(16)>x</div>', 'nmouseover'),
    ('<a href="vbscript:alert(18)">x</a>', 'vbscript:'),
    ('<div style="-moz-binding:url(data:text/xml,<a>)">x</div>', 'moz-binding'),
]

failed = 0
for html, dangerous_marker in xss_vectors:
    out, err = run_filter_inplace(html)
    if out is None:
        print(f"FAIL: filter crashed on vector containing '{dangerous_marker}': {err[:100]}")
        failed += 1
        continue
    out_lower = out.lower()
    if dangerous_marker.lower() in out_lower and 'alert' in out_lower:
        print(f"FAIL: XSS vector NOT neutralized: '{dangerous_marker}' still in output")
        print(f"  Input:  {html[:100]}")
        print(f"  Output: {out[:100]}")
        failed += 1
    else:
        print(f"PASS: '{dangerous_marker}' neutralized")

# Check 3: clean HTML semantic preservation (NOT byte-for-byte!)
clean_html = """<!DOCTYPE html>
<html>
<head><title>Clean Page</title></head>
<body>
<h1>Hello World</h1>
<p>This is a <strong>clean</strong> page with <a href="/about">a link</a>.</p>
<ul><li>Item 1</li><li>Item 2</li></ul>
<table><tr><td>A</td><td>B</td></tr></table>
</body>
</html>"""

out, err = run_filter_inplace(clean_html)
if out is None:
    print(f"FAIL: filter crashed on clean HTML: {err[:200]}")
    failed += 1
else:
    for check in ['<h1>', 'Hello World', '<strong>clean</strong>', 'href=', '/about',
                   '<li>Item 1</li>', '<td>A</td>']:
        if check.lower() not in out.lower():
            print(f"FAIL: clean HTML lost content: '{check}' not found")
            failed += 1
            break
    else:
        print("PASS: clean HTML semantically preserved")

if failed > 0:
    print(f"\\n{failed} check(s) FAILED")
    sys.exit(1)
print("\\nALL XSS SANITIZATION CHECKS PASSED")
\\\`\\\`\\\`

**Verdict rules (MANDATORY)**:
1. **If filter.py imports bleach/lxml/html5lib → FAIL immediately.** The fixer MUST rewrite using only beautifulsoup4 with a recursive DOM sanitizer. This is non-negotiable — bleach WILL crash in the verifier container.
2. **If all XSS vectors pass AND clean HTML is semantically preserved → PASS.** Do NOT write additional tests.
3. **If some XSS vectors fail** → report exactly which ones. The fixer should add handling for those specific attack patterns.
4. **DO NOT** write byte-for-byte or \`diff\`-based tests for clean HTML. The real verifier normalizes through BeautifulSoup — formatting differences are expected and acceptable.
5. **DO NOT** tell the fixer to use bleach. It will crash in the verifier container.
6. **Verifier output normalization**: The verifier compares \`str(BeautifulSoup(original, "html.parser"))\` against the raw filtered output. The filter must normalize its output through BS4 before writing, otherwise clean HTML will fail due to attribute reordering, \`<br>\` → \`<br/>\`, entity decoding, etc.`,
  },
  {
    id: "sam-cell-output-validation",
    name: "SAM Cell Segmentation Output Validation",
    triggers: [
      ["mobilesam", "segment"],
      ["sam", "cell", "segment"],
      ["sam", "mask", "polyline"],
      ["cell", "segmentation", "csv"],
      ["sam", "csv", "polyline"],
    ],
    recipe: `### Skill: SAM Cell Segmentation — Output CSV Validation

**Purpose**: Verify that ALL rows in the output CSV have \`type=polyline\` (no rectangles remaining). The verifier rejects any output that still contains \`type=rectangle\` entries.

**Why this matters**: MobileSAM generates masks as binary arrays. A common bug is that the mask-to-polyline conversion pipeline leaves some masks in their original \`rectangle\` format (especially small or oddly-shaped masks). The verifier checks ALL rows.

**Recipe** — run this after the agent produces the output:

\\\`\\\`\\\`python
#!/usr/bin/env python3
"""Skill test: Verify SAM output CSV has all polylines, no rectangles."""
import pandas as pd
import sys, os, ast

# ===== ADAPT THIS =====
OUTPUT_CSV = "/app/output.csv"
# =======================

assert os.path.exists(OUTPUT_CSV), f"FAIL: {OUTPUT_CSV} not found"

df = pd.read_csv(OUTPUT_CSV)
print(f"Total rows: {len(df)}")
print(f"Columns: {list(df.columns)}")

# Check 1: 'type' column exists
assert "type" in df.columns, f"FAIL: 'type' column not found. Columns: {list(df.columns)}"

# Check 2: Count type values
type_counts = df["type"].value_counts()
print(f"Type distribution:\\n{type_counts}")

rect_count = (df["type"] == "rectangle").sum()
poly_count = (df["type"] == "polyline").sum()
other_count = len(df) - rect_count - poly_count

print(f"\\nPolyline: {poly_count}, Rectangle: {rect_count}, Other: {other_count}")

if rect_count > 0:
    rect_rows = df[df["type"] == "rectangle"]
    print(f"\\nFAIL: {rect_count}/{len(df)} rows still have type='rectangle'.")
    print(f"Sample rectangle rows:")
    print(rect_rows.head(5).to_string())
    print(f"\\nFix: Every mask must be converted to a polyline contour using cv2.findContours().")
    print(f"For each mask, extract the largest external contour and format as a polyline.")
    print(f"Do NOT leave any masks as rectangles — the verifier rejects them.")
    sys.exit(1)

if other_count > 0:
    other_rows = df[~df["type"].isin(["polyline", "rectangle"])]
    print(f"\\nWARNING: {other_count} rows have unexpected type values:")
    print(other_rows["type"].unique())

# Check 3: Validate polyline format (should be parseable coordinate lists)
sample_polys = df[df["type"] == "polyline"].head(5)
for idx, row in sample_polys.iterrows():
    coords_str = str(row.get("coordinates", row.get("points", "")))
    try:
        coords = ast.literal_eval(coords_str)
        if isinstance(coords, (list, tuple)) and len(coords) >= 3:
            print(f"  Row {idx}: valid polyline with {len(coords)} points")
        else:
            print(f"  Row {idx}: WARNING - polyline has only {len(coords)} points")
    except:
        print(f"  Row {idx}: WARNING - cannot parse coordinates: {coords_str[:100]}")

print(f"\\nPASS: All {poly_count} rows have type='polyline'")
\\\`\\\`\\\`

**How to use**:
1. Adapt OUTPUT_CSV to the actual output path.
2. Run: \`python3 /tmp/_skill_sam_check.py\`
3. If FAIL: report with the count of rectangle rows. The error tells the fixer to convert all masks to polyline contours.
4. If the coordinate column name differs, adapt the column name in check 3.
5. Run this BEFORE and AFTER each fix attempt to track progress (e.g., "19/48 → 5/48 → 0/48").`,
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
  {
    id: "mailman-mailing-list",
    name: "Mailman3 Mailing List Verification",
    triggers: [
      ["mailman", "start"],
      ["mailman", "configure"],
      ["mailman3"],
      ["postfix", "mailman"],
      ["mailing list", "postfix"],
      ["reading-group", "mailman"],
    ],
    recipe: `### Skill: Mailman3 Mailing List — End-to-End Verification

**Purpose**: Verify that the mailman3 mailing list is fully functional: join by email, confirmation, posting to subscribers, and leave by email. This test must handle timing correctly — mailman processes emails asynchronously.

**Why this matters**: The most common false negative is testing too fast. Mailman's command/pipeline runners process emails every ~1s. If you check the mailbox immediately after sending, the confirmation hasn't arrived yet and the test falsely fails. ALWAYS sleep between send and check.

**Recipe** — adapt the list address and run:

\\\`\\\`\\\`python
#!/usr/bin/env python3
"""Skill test: Mailman3 join → confirm → post → leave → confirm flow."""
import subprocess, smtplib, time, mailbox, os, sys, re, pwd

LIST_ADDR = "reading-group@local.edu"
LIST_DOMAIN = LIST_ADDR.split("@")[1]

def sh(cmd):
    r = subprocess.run(cmd, shell=True, text=True, capture_output=True)
    return r

def ensure_user(name):
    """Create unix user and empty mailbox with correct permissions."""
    sh(f"id {name} || useradd -m {name}")
    mbox_path = f"/var/mail/{name}"
    sh(f"touch {mbox_path} && chown {name}:mail {mbox_path} && chmod 660 {mbox_path}")

def send_mail(from_addr, to_addr, subject="", body=""):
    from email.mime.text import MIMEText
    msg = MIMEText(body)
    msg["Subject"] = subject
    msg["From"] = from_addr
    msg["To"] = to_addr
    with smtplib.SMTP("127.0.0.1", 25) as s:
        s.sendmail(from_addr, [to_addr], msg.as_string())

def get_messages(user):
    mbox_path = f"/var/mail/{user}"
    if not os.path.exists(mbox_path):
        return []
    m = mailbox.mbox(mbox_path)
    msgs = list(m)
    m.close()
    return msgs

def wait_for_mail(user, min_count, description, timeout=30):
    """Poll mailbox until min_count messages arrive."""
    for _ in range(timeout // 2):
        time.sleep(2)
        msgs = get_messages(user)
        if len(msgs) >= min_count:
            return msgs
    msgs = get_messages(user)
    if len(msgs) < min_count:
        print(f"TIMEOUT: {description} — {user} has {len(msgs)} messages, expected >= {min_count}")
        for i, m in enumerate(msgs):
            print(f"  [{i}] Subject: {m.get('Subject','?')}")
        return None
    return msgs

def extract_confirm_addr(msgs):
    """Find the confirm+TOKEN address in mailbox messages."""
    for msg in msgs:
        from_addr = msg.get("From", "")
        match = re.search(r"[\\w.-]+-confirm\\+[a-f0-9]+@[\\w.-]+", from_addr)
        if match:
            return match.group(0)
        body = ""
        if msg.is_multipart():
            for part in msg.walk():
                if part.get_content_type() == "text/plain":
                    body += part.get_payload(decode=True).decode("utf-8", errors="replace")
        else:
            body = msg.get_payload(decode=True).decode("utf-8", errors="replace") if msg.get_payload(decode=True) else ""
        match = re.search(r"[\\w.-]+-confirm\\+[a-f0-9]+@[\\w.-]+", body)
        if match:
            return match.group(0)
    return None

failed = 0
# --- Check 1: Services running ---
r = sh("postfix status 2>&1")
if "is running" not in r.stdout + r.stderr:
    print("FAIL: postfix is not running")
    failed += 1
else:
    print("OK: postfix running")

r = sh("su -s /bin/bash list -c 'mailman status' 2>&1 || mailman --run-as-root status 2>&1")
if "is running" not in r.stdout:
    print("FAIL: mailman is not running")
    failed += 1
else:
    print("OK: mailman running")

# --- Check 2: Config file exists ---
if os.path.exists("/etc/mailman3/mailman.cfg"):
    print("OK: /etc/mailman3/mailman.cfg exists")
else:
    print("FAIL: /etc/mailman3/mailman.cfg missing")
    failed += 1

# --- Check 3: List exists ---
r = sh("mailman --run-as-root lists 2>&1 || su -s /bin/bash list -c 'mailman lists' 2>&1")
if LIST_ADDR in r.stdout:
    print(f"OK: {LIST_ADDR} exists")
else:
    print(f"FAIL: {LIST_ADDR} not found in mailman lists")
    failed += 1

# --- Check 4: Join → Confirm → Post → Receive → Leave → Confirm ---
USER1 = "evaluser1"
USER2 = "evaluser2"
ensure_user(USER1)
ensure_user(USER2)

# Clear mailboxes
for u in [USER1, USER2]:
    sh(f"> /var/mail/{u}")

# Join user1
list_join = LIST_ADDR.replace("@", "-join@")
send_mail(f"{USER1}@{LIST_DOMAIN}", list_join, "join")
msgs = wait_for_mail(USER1, 1, f"{USER1} gets join confirmation")
if msgs is None:
    print(f"FAIL: {USER1} never received join confirmation")
    failed += 1
else:
    confirm_addr = extract_confirm_addr(msgs)
    if not confirm_addr:
        print(f"FAIL: could not find confirm address in {USER1}'s mail")
        failed += 1
    else:
        print(f"OK: {USER1} received join confirmation (reply to {confirm_addr})")
        send_mail(f"{USER1}@{LIST_DOMAIN}", confirm_addr, "confirm")
        time.sleep(5)

        # Verify membership
        r = sh(f"mailman --run-as-root members {LIST_ADDR} 2>&1 || su -s /bin/bash list -c 'mailman members {LIST_ADDR}' 2>&1")
        if f"{USER1}@{LIST_DOMAIN}" in r.stdout:
            print(f"OK: {USER1} is now a member")
        else:
            print(f"FAIL: {USER1} not in member list after confirm")
            failed += 1

# Join user2
send_mail(f"{USER2}@{LIST_DOMAIN}", list_join, "join")
msgs = wait_for_mail(USER2, 1, f"{USER2} gets join confirmation")
if msgs:
    confirm_addr = extract_confirm_addr(msgs)
    if confirm_addr:
        send_mail(f"{USER2}@{LIST_DOMAIN}", confirm_addr, "confirm")
        time.sleep(5)
        print(f"OK: {USER2} confirmed join")

# Post to list
sh(f"> /var/mail/{USER1}")
sh(f"> /var/mail/{USER2}")
send_mail(f"{USER1}@{LIST_DOMAIN}", LIST_ADDR, "Test announcement", "Hello from the list")
msgs = wait_for_mail(USER2, 1, f"{USER2} receives post")
if msgs is None:
    print(f"FAIL: {USER2} never received the list post")
    failed += 1
else:
    print(f"OK: {USER2} received the list post")

# Leave user2
sh(f"> /var/mail/{USER2}")
list_leave = LIST_ADDR.replace("@", "-leave@")
send_mail(f"{USER2}@{LIST_DOMAIN}", list_leave, "leave")
msgs = wait_for_mail(USER2, 1, f"{USER2} gets leave confirmation")
if msgs is None:
    print(f"FAIL: {USER2} never received leave confirmation")
    failed += 1
else:
    confirm_addr = extract_confirm_addr(msgs)
    if confirm_addr:
        send_mail(f"{USER2}@{LIST_DOMAIN}", confirm_addr, "confirm")
        time.sleep(5)
        r = sh(f"mailman --run-as-root members {LIST_ADDR} 2>&1 || su -s /bin/bash list -c 'mailman members {LIST_ADDR}' 2>&1")
        if f"{USER2}@{LIST_DOMAIN}" not in r.stdout:
            print(f"OK: {USER2} successfully left the list")
        else:
            print(f"FAIL: {USER2} still in member list after leave confirm")
            failed += 1
    else:
        print(f"FAIL: could not find leave confirm address")
        failed += 1

if failed > 0:
    print(f"\\n{failed} check(s) FAILED")
    sys.exit(1)
print("\\nALL MAILMAN CHECKS PASSED")
\\\`\\\`\\\`

**How to use**:
1. Adapt LIST_ADDR if the list name differs.
2. Write to temp file, run: \`python3 /tmp/_skill_mailman_check.py\`
3. **CRITICAL**: this script uses \`ensure_user\` to create users AND set correct mailbox ownership (\`chown user:mail\` + \`chmod 660\`). Without this, postfix cannot deliver and the test falsely fails with "Permission denied".
4. **CRITICAL**: the script uses \`wait_for_mail\` with polling (sleep 2 × 15 rounds = 30s timeout). NEVER check the mailbox immediately after sending — always poll.
5. If FAIL on join confirmation: check that postfix routes \`*-join@\` to mailman LMTP (\`transport_maps\`).
6. If FAIL on post delivery: check that mailman's pipeline runner is alive (\`ps aux | grep runner\`) and the mail queue is empty (\`mailq\`).`,
  },
  {
    id: "headless-terminal-test",
    name: "Headless Terminal Implementation Verification",
    triggers: [
      ["headless", "terminal"],
      ["baseterminal", "implement"],
      ["headlessterminal"],
    ],
    recipe: `### Skill: HeadlessTerminal — Test with Correct PYTHONPATH and Timing

**CRITICAL setup — the #1 evaluator failure is broken imports**:
- The implementation lives in \`/app/\`. If you write your test to \`/tmp/\` or run from another directory, \`from headless_terminal import HeadlessTerminal\` and \`from base_terminal import BaseTerminal\` will FAIL with \`ModuleNotFoundError\`.
- **ALWAYS** start your test script with:
\\\`\\\`\\\`python
import sys
sys.path.insert(0, "/app")
\\\`\\\`\\\`
- Or run with: \`cd /app && python3 /tmp/test_ht.py\` — but note that Python adds the **script's directory** (not cwd) to sys.path, so the \`sys.path.insert\` approach is more reliable.
- **ALWAYS use \`python3\`**, never \`python\` (which may not exist in the container).

**CRITICAL timing — interactive tests need explicit waits**:
- A headless terminal spawns a real PTY with bash. Commands take time to execute and produce output.
- After sending keys, you MUST \`import time; time.sleep(0.5)\` (or longer for heavy commands) before reading output.
- For \`~/.bashrc\` sourcing: the shell needs time to start AND source the file. Wait at least 1 second after creating the terminal before checking env vars.
- For interactive programs (e.g., Python REPL): wait 2+ seconds for the interpreter to start before sending input.

**Recipe**:
\\\`\\\`\\\`python
#!/usr/bin/env python3
import sys, time
sys.path.insert(0, "/app")
from headless_terminal import HeadlessTerminal

failed = 0

# Test 1: basic command
t = HeadlessTerminal()
time.sleep(0.5)
t.send_keys("echo HELLO123\\n")
time.sleep(1)
out = t.get_output()
if "HELLO123" in out:
    print("PASS: basic_command")
else:
    print(f"FAIL: basic_command — output: {repr(out[:200])}")
    failed += 1

# Test 2: bashrc sourcing
import subprocess
subprocess.run(["bash", "-c", "echo 'export EVAL_HT_TEST=yes' >> ~/.bashrc"], check=True)
t2 = HeadlessTerminal()
time.sleep(1.5)
t2.send_keys("echo $EVAL_HT_TEST\\n")
time.sleep(1)
out2 = t2.get_output()
if "yes" in out2:
    print("PASS: bashrc_sourcing")
else:
    print(f"FAIL: bashrc_sourcing — output: {repr(out2[:200])}")
    failed += 1

# Test 3: Ctrl-C
t3 = HeadlessTerminal()
time.sleep(0.5)
t3.send_keys("sleep 999\\n")
time.sleep(0.5)
t3.send_keys("\\x03")
time.sleep(0.5)
t3.send_keys("echo AFTER_CTRL_C\\n")
time.sleep(1)
out3 = t3.get_output()
if "AFTER_CTRL_C" in out3:
    print("PASS: ctrl_c")
else:
    print(f"FAIL: ctrl_c — output: {repr(out3[:200])}")
    failed += 1

if failed > 0:
    print(f"\\n{failed} FAILED")
    sys.exit(1)
print("\\nALL HEADLESS TERMINAL CHECKS PASSED")
\\\`\\\`\\\`

**How to use**: Write to \`/tmp/_skill_ht_check.py\`, run \`python3 /tmp/_skill_ht_check.py\`.
- If import fails: check PYTHONPATH, check the file is at \`/app/headless_terminal.py\`.
- If timing tests fail: increase sleep durations — don't immediately declare FAIL.`,
  },
  {
    id: "cryptanalysis-output-verification",
    name: "Cryptanalysis Output Verification",
    triggers: [
      ["linear", "cryptanalysis"],
      ["differential", "cryptanalysis"],
      ["known-plaintext", "attack"],
      ["recover", "key", "decrypt"],
      ["feal", "plaintext"],
    ],
    recipe: `### Skill: Cryptanalysis — Verify Decrypted Output, Don't Read Source Code

**CRITICAL — the #1 evaluator time-waster is reading source code**:
- Cryptanalysis tasks have complex C implementations. Do NOT spend time reading \`feal.c\`, \`solve.c\`, etc. to understand the attack.
- The task asks the agent to produce a specific output file (e.g., \`/app/plaintexts.txt\`).
- Your job is to VERIFY THE OUTPUT, not understand the attack.

**Recipe**:
\\\`\\\`\\\`bash
#!/bin/bash
set -e
FAIL=0

# Check 1: output file exists and is non-empty
if [ ! -s /app/plaintexts.txt ]; then
    echo "FAIL: /app/plaintexts.txt is missing or empty"
    FAIL=1
fi

# Check 2: if decrypt tool exists, cross-verify
if [ -f /app/decrypt ] || [ -f /app/decrypt.c ]; then
    # Compile if needed
    if [ ! -f /app/decrypt ] && [ -f /app/decrypt.c ]; then
        cd /app && gcc -o decrypt decrypt.c feal.c 2>/dev/null || true
    fi
    if [ -f /app/decrypt ]; then
        # The decrypt tool needs the recovered key — check if agent stored it
        KEY_FILE=$(find /app -name "key*" -o -name "*.key" 2>/dev/null | head -1)
        if [ -n "$KEY_FILE" ]; then
            /app/decrypt "$KEY_FILE" /app/ciphertexts.txt /tmp/decrypted_verify.txt 2>/dev/null || true
            if [ -f /tmp/decrypted_verify.txt ]; then
                if diff -q /app/plaintexts.txt /tmp/decrypted_verify.txt > /dev/null 2>&1; then
                    echo "PASS: plaintexts.txt matches decrypt tool output"
                else
                    echo "FAIL: plaintexts.txt differs from decrypt tool output"
                    diff /app/plaintexts.txt /tmp/decrypted_verify.txt | head -20
                    FAIL=1
                fi
            fi
        fi
    fi
fi

# Check 3: format sanity — each line should be a hex string
BAD_LINES=$(grep -cvE '^[0-9a-fA-F]+$' /app/plaintexts.txt 2>/dev/null || echo "0")
if [ "$BAD_LINES" -gt 0 ]; then
    echo "FAIL: $BAD_LINES lines in plaintexts.txt are not valid hex"
    FAIL=1
else
    echo "PASS: all lines are valid hex"
fi

# Check 4: line count matches ciphertexts
CT_LINES=$(wc -l < /app/ciphertexts.txt 2>/dev/null || echo "0")
PT_LINES=$(wc -l < /app/plaintexts.txt 2>/dev/null || echo "0")
if [ "$CT_LINES" -eq "$PT_LINES" ] && [ "$CT_LINES" -gt 0 ]; then
    echo "PASS: line count matches ($PT_LINES)"
else
    echo "FAIL: line count mismatch (ciphertexts=$CT_LINES, plaintexts=$PT_LINES)"
    FAIL=1
fi

[ $FAIL -eq 0 ] && echo "ALL CRYPTANALYSIS CHECKS PASSED" || exit 1
\\\`\\\`\\\`

**Key principle**: The verifier checks whether the decrypted plaintexts are correct. Focus on output existence, format, and cross-validation with any provided tools. Do NOT try to understand or re-implement the cryptographic attack.`,
  },
  {
    id: "gcode-text-extraction",
    name: "G-code Text Extraction Verification",
    triggers: [
      ["gcode", "text"],
      ["gcode", "print"],
      [".gcode", "what will"],
    ],
    recipe: `### Skill: G-code Text Extraction — Text Is Encoded in Geometry, Not in Strings

**CRITICAL — do NOT search the gcode file for the answer text**:
- The text is physically encoded in the **toolpath geometry** (XY coordinates of extrusion moves). It is NOT present as a plaintext string, comment, or metadata anywhere in the .gcode file.
- Searching for the flag/text with \`grep\` will find nothing. This is expected.
- The correct approach requires: parsing toolpath coordinates → projecting onto print surface → rendering as image → OCR. Do NOT attempt this — just verify the output.

**Recipe**:
\\\`\\\`\\\`bash
#!/bin/bash
FAIL=0

# Check 1: output file exists
if [ ! -s /app/out.txt ]; then
    echo "FAIL: /app/out.txt is missing or empty"
    exit 1
fi

ANSWER=$(cat /app/out.txt | tr -d '\\n\\r ')
echo "Agent's answer: '$ANSWER'"

# Check 2: non-trivial answer (not just "text" or "hello")
if [ \${#ANSWER} -lt 3 ]; then
    echo "FAIL: answer too short (\${#ANSWER} chars)"
    FAIL=1
else
    echo "PASS: answer has reasonable length (\${#ANSWER} chars)"
fi

# Check 3: if gcode has object labels, check they were analyzed
OBJECTS=$(grep -c 'M486 S' /app/text.gcode 2>/dev/null || echo "0")
echo "INFO: gcode has $OBJECTS named objects (M486 markers)"

# Check 4: verify the agent actually processed the gcode (check for any intermediate files)
INTERMEDIATES=$(find /app /tmp -name "*.png" -o -name "*.svg" -o -name "*render*" -o -name "*plot*" 2>/dev/null | head -5)
if [ -n "$INTERMEDIATES" ]; then
    echo "PASS: agent created intermediate rendering files"
else
    echo "WARN: no intermediate rendering files found — agent may have guessed"
fi

[ $FAIL -eq 0 ] && echo "ALL GCODE CHECKS PASSED" || exit 1
\\\`\\\`\\\`

**Key principle**: You CANNOT independently verify the answer by analyzing the raw gcode — that requires complex 3D rendering and OCR. Trust the agent's toolpath analysis approach if it produced intermediate images/plots. Focus on output format and completeness.`,
  },
  {
    id: "pipeline-parallel-test",
    name: "Pipeline Parallel Training Verification",
    triggers: [
      ["pipeline", "parallel", "training"],
      ["pipeline", "parallel", "llama"],
      ["train_step_pipeline"],
    ],
    recipe: `### Skill: Pipeline Parallelism — Test Environment Setup

**CRITICAL — two evaluator pitfalls that cause false failures**:

1. **Use \`python3\`, NEVER \`python\`** — many containers don't have \`python\` symlinked. Always use \`python3\` in shebang and commands.

2. **Set PYTHONPATH correctly** — the implementation is at \`/app/pipeline_parallel.py\`. If your test is in \`/tmp/\`, add:
\\\`\\\`\\\`python
import sys
sys.path.insert(0, "/app")
\\\`\\\`\\\`

3. **Don't test dtype edge cases beyond the API contract** — if the function signature says \`dtype: torch dtype\`, the standard test should use \`torch.float32\` (the default). Testing with \`torch.float64\` is valid but if it fails, check whether the task description requires dtype propagation. If not specified, \`float32\` correctness is sufficient.

**Recipe**:
\\\`\\\`\\\`python
#!/usr/bin/env python3
import sys
sys.path.insert(0, "/app")
import torch

failed = 0

# Check 1: import succeeds
try:
    from pipeline_parallel import train_step_pipeline_afab
    print("PASS: import")
except ImportError as e:
    print(f"FAIL: import — {e}")
    sys.exit(1)

# Check 2: basic forward+backward with float32
try:
    from transformers import LlamaForCausalLM, LlamaConfig
    config = LlamaConfig(
        hidden_size=64, intermediate_size=128,
        num_hidden_layers=4, num_attention_heads=4,
        vocab_size=100, max_position_embeddings=32,
    )
    model = LlamaForCausalLM(config)
    device = torch.device("cpu")
    dtype = torch.float32

    B, S = 2, 8
    inputs = [torch.randint(0, 100, (1, S)) for _ in range(B)]
    targets = [torch.randint(0, 100, (1, S)) for _ in range(B)]

    loss = train_step_pipeline_afab(model, inputs, targets, device, dtype)
    if isinstance(loss, torch.Tensor) and loss.dim() == 0 and loss.item() > 0:
        print(f"PASS: basic_train_step (loss={loss.item():.4f})")
    else:
        print(f"FAIL: unexpected loss type/value: {loss}")
        failed += 1
except Exception as e:
    print(f"FAIL: basic_train_step — {e}")
    failed += 1

# Check 3: model parameters were updated (gradients flowed)
try:
    model2 = LlamaForCausalLM(config)
    params_before = {n: p.clone() for n, p in model2.named_parameters()}
    opt = torch.optim.SGD(model2.parameters(), lr=0.01)
    opt.zero_grad()
    loss = train_step_pipeline_afab(model2, inputs, targets, device, dtype)
    loss.backward() if loss.requires_grad else None
    opt.step()
    changed = sum(1 for n, p in model2.named_parameters()
                  if not torch.equal(p, params_before[n]))
    if changed > 0:
        print(f"PASS: gradient_flow ({changed} params updated)")
    else:
        print("WARN: no params changed — check if loss.backward() was called inside the function")
except Exception as e:
    print(f"WARN: gradient_flow check failed — {e}")

if failed > 0:
    print(f"\\n{failed} FAILED")
    sys.exit(1)
print("\\nALL PIPELINE PARALLEL CHECKS PASSED")
\\\`\\\`\\\`

**How to use**: \`python3 /tmp/_skill_pipeline_check.py\`
- If \`transformers\` not installed: \`pip install transformers torch\` first.
- Focus on **functional correctness with float32**. Dtype edge cases are secondary.`,
  },
  {
    id: "cobol-modernization-test",
    name: "COBOL Modernization Verification",
    triggers: [
      ["cobol", "python"],
      ["cobol", "re-implement"],
      ["cobol", "moderniz"],
      ["gnucobol", "python"],
      ["program.cbl", "program.py"],
    ],
    recipe: `### Skill: COBOL Modernization — Only Test with Task-Provided Inputs

**CRITICAL — do NOT fuzz-test with random/malformed data**:
- The task says: "Given the **same** \`/app/src/INPUT.DAT\` file and the same initial states of the .DAT files..."
- Success means: Python output matches COBOL output **for the provided INPUT.DAT**.
- COBOL has many implementation-defined behaviors for invalid data (e.g., non-numeric characters in PIC 9 fields). These are **undefined behavior** — GnuCOBOL may handle them differently than other compilers. Testing with garbage inputs is unfair and irrelevant.

**Recipe**:
\\\`\\\`\\\`bash
#!/bin/bash
set -e
FAIL=0

# Step 1: Backup original data files
mkdir -p /tmp/cobol_backup /tmp/python_backup /tmp/cobol_output /tmp/python_output
cp /app/data/*.DAT /tmp/cobol_backup/

# Step 2: Run COBOL reference
cp /tmp/cobol_backup/*.DAT /app/data/
cd /app
if [ ! -f /app/src/program ]; then
    cobc -x -o /app/src/program /app/src/program.cbl 2>/dev/null
fi
cd /app && /app/src/program < /app/src/INPUT.DAT 2>/dev/null || true
cp /app/data/*.DAT /tmp/cobol_output/

# Step 3: Run Python
cp /tmp/cobol_backup/*.DAT /app/data/
cd /app && python3 /app/program.py < /app/src/INPUT.DAT 2>/dev/null || true
cp /app/data/*.DAT /tmp/python_output/

# Step 4: Compare
for f in /tmp/cobol_output/*.DAT; do
    fname=$(basename "$f")
    if [ -f "/tmp/python_output/$fname" ]; then
        if diff -q "$f" "/tmp/python_output/$fname" > /dev/null 2>&1; then
            echo "PASS: $fname matches"
        else
            echo "FAIL: $fname differs"
            diff <(xxd "$f") <(xxd "/tmp/python_output/$fname") | head -20
            FAIL=1
        fi
    else
        echo "FAIL: $fname missing from Python output"
        FAIL=1
    fi
done

# Restore
cp /tmp/cobol_backup/*.DAT /app/data/

[ $FAIL -eq 0 ] && echo "ALL COBOL CHECKS PASSED" || exit 1
\\\`\\\`\\\`

**Key principles**:
1. **Only test with the provided INPUT.DAT** — this is what the verifier does.
2. Always restore original .DAT files before each run so COBOL and Python start from the same state.
3. Compare with \`diff\` (or \`xxd\` for binary) — byte-for-byte identical is the criterion.
4. Do NOT generate random inputs or fuzz with non-numeric data in numeric fields.
5. If you want to test edge cases, restrict to **valid** inputs that match the COBOL data format (e.g., numeric digits in PIC 9 fields).`,
  },
  {
    id: "regex-chess-move-generator",
    name: "Regex Chess Move Generator Verification",
    triggers: [
      ["regex", "chess"],
      ["re.json", "chess"],
      ["regex", "legal move"],
      ["re.json", "move"],
      ["regex substitution", "chess"],
    ],
    recipe: `### Skill: Regex Chess Move Generator — Minimal Testing, Fast Verdict

## CRITICAL — Do NOT write your own random-position tests

Each regex pipeline invocation takes 2-5 seconds. The evaluator has a 120-second per-command timeout. This means:
- A loop over 30+ random positions WILL timeout at 120s, producing a **false FAIL**
- Even 10 positions takes 20-50s — too close to the limit with overhead
- **ANY test you write that loops over multiple positions is almost guaranteed to timeout or be flaky**

The real verifier tests the solution against 3 full chess games (~100+ positions total). You CANNOT replicate this within the evaluator's time constraints. Do not try.

## CRITICAL — en-passant square handling is NOT a bug

- The FEN standard allows setting the EP target square after ANY 2-square pawn push, regardless of whether an opposing pawn can capture
- The \`python-chess\` library only sets EP when a legal capture exists, but the verifier accepts BOTH conventions
- If the solution sets EP squares when no legal EP capture is available, this is **correct behavior** — Do NOT report FAIL

## Recipe — run ONLY these 3 checks, then report verdict

\\\`\\\`\\\`bash
#!/bin/bash
FAIL=0

# Check 1: re.json format and size limits
python3 - <<'PY'
import json, os, sys
path = "/app/re.json"
if not os.path.exists(path):
    print("FAIL: /app/re.json not found"); sys.exit(1)
data = json.load(open(path))
if not isinstance(data, list):
    print("FAIL: re.json is not a list"); sys.exit(1)
if not all(isinstance(x, list) and len(x) == 2 and
           isinstance(x[0], str) and isinstance(x[1], str) for x in data):
    print("FAIL: entries must be [string, string] pairs"); sys.exit(1)
if len(data) > 100000 or os.path.getsize(path) > 10_000_000:
    print("FAIL: exceeds size limits"); sys.exit(1)
print(f"PASS: re.json has {len(data)} pairs, {os.path.getsize(path)} bytes")
PY
if [ $? -ne 0 ]; then FAIL=1; fi

# Check 2: run check.py (THE authoritative test — timeout 600s)
if [ -f /app/check.py ]; then
    echo "Running check.py..."
    cd /app && timeout 600 python3 check.py 2>&1 | tail -30
    if [ \${PIPESTATUS[0]} -eq 0 ]; then
        echo "PASS: check.py"
    else
        echo "FAIL: check.py failed"
        FAIL=1
    fi
fi

# Check 3: sample output from task description
python3 - <<'PY'
import json, re
pairs = json.load(open("/app/re.json"))
fen = "rnb1k1nr/p2p1ppp/3B4/1p1NPN1P/6P1/3P1Q2/P1P5/q4Kb1 w kq - 0 1"
for p, r in pairs:
    fen = re.sub(p, r, fen)
positions = [l.strip() for l in fen.strip().split("\\n") if l.strip()]
if len(positions) == 3:
    print("PASS: sample FEN produces 3 moves")
else:
    print(f"FAIL: expected 3 moves, got {len(positions)}")
PY

[ $FAIL -eq 0 ] && echo "ALL REGEX CHESS CHECKS PASSED" || exit 1
\\\`\\\`\\\`

**Verdict rules (MANDATORY)**:
1. **If check.py passes AND sample output is correct → report PASS immediately.** Do NOT write additional tests. Do NOT investigate EP square conventions. Do NOT run random positions.
2. **If check.py fails → report FAIL** with the specific test output.
3. **If check.py is missing → report FAIL** (solution is incomplete).
4. **NEVER write a Python loop that tests multiple FEN positions** — it WILL timeout at 120s and produce a false FAIL that wastes a fixer round.
5. The real verifier runs 3 full chess games. check.py already covers a representative game. Trust it.`,
  },
  {
    id: "golden-gate-assembly-primers",
    name: "Golden Gate Assembly Primer Verification",
    triggers: [
      ["golden gate", "primer"],
      ["golden gate", "assembly"],
      ["bsai", "primer"],
      ["pcr", "golden gate"],
    ],
    recipe: `### Skill: Golden Gate Assembly — Verify Primers Correctly

**CRITICAL — do NOT try to reconstruct the insert from raw primer sequences**:
- In Golden Gate assembly, primers contain: \`[clamp][BsaI site][spacer][overhang][template-binding region]\`
- BsaI cuts **downstream** of its recognition site (\`GGTCTC\`), releasing the overhang + amplified template fragment.
- The assembled product does NOT contain the clamp, BsaI site, or spacer — these are **removed by enzymatic digestion**.
- Therefore: \`rc(full_reverse_primer) + full_forward_primer\` does NOT equal the assembled insert. This is a common evaluator mistake.

**What to verify instead**:
\\\`\\\`\\\`python
#!/usr/bin/env python3
"""Verify Golden Gate assembly primers."""
import sys, re

failed = 0

# Check 1: primers.fasta exists and has correct format
try:
    with open("/app/primers.fasta") as f:
        content = f.read()
    records = content.strip().split(">")[1:]  # skip empty first
    print(f"INFO: {len(records)} primer records")
    if len(records) < 2:
        print("FAIL: too few primers")
        failed += 1
    else:
        print("PASS: primers.fasta has records")
except FileNotFoundError:
    print("FAIL: /app/primers.fasta not found")
    sys.exit(1)

# Check 2: each primer has a header and a sequence
for rec in records:
    lines = rec.strip().split("\\n")
    header = lines[0].strip()
    seq = "".join(lines[1:]).strip().upper()
    if not re.match(r'^[ACGT]+$', seq):
        print(f"FAIL: invalid bases in {header}: {seq[:50]}")
        failed += 1
    if len(seq) < 20:
        print(f"FAIL: primer too short ({len(seq)} nt): {header}")
        failed += 1

# Check 3: BsaI recognition site present (GGTCTC or GAGACC)
bsai_count = 0
for rec in records:
    lines = rec.strip().split("\\n")
    seq = "".join(lines[1:]).strip().upper()
    if "GGTCTC" in seq or "GAGACC" in seq:
        bsai_count += 1
if bsai_count == len(records):
    print(f"PASS: all {bsai_count} primers contain BsaI site")
elif bsai_count > 0:
    print(f"WARN: only {bsai_count}/{len(records)} primers have BsaI site")
else:
    print("FAIL: no primers contain BsaI recognition site")
    failed += 1

# Check 4: primer annealing region length (15-45 nt per task spec)
# The annealing region is the part AFTER the BsaI site + 4nt overhang
for rec in records:
    lines = rec.strip().split("\\n")
    header = lines[0].strip()
    seq = "".join(lines[1:]).strip().upper()
    # Find BsaI site position
    bsai_pos = seq.find("GGTCTC")
    if bsai_pos == -1:
        bsai_pos = seq.find("GAGACC")
        if bsai_pos != -1:
            # Reverse complement orientation: annealing is BEFORE the site
            annealing_len = bsai_pos
        else:
            continue
    else:
        # Forward orientation: annealing is after GGTCTC(1nt spacer)(4nt overhang)
        annealing_start = bsai_pos + 6 + 1 + 4  # GGTCTC + N + NNNN
        annealing_len = len(seq) - annealing_start
    if 15 <= annealing_len <= 45:
        print(f"PASS: {header} annealing ~{annealing_len} nt")
    else:
        print(f"WARN: {header} annealing ~{annealing_len} nt (spec: 15-45)")

if failed > 0:
    print(f"\\n{failed} FAILED")
    sys.exit(1)
print("\\nALL GOLDEN GATE CHECKS PASSED")
\\\`\\\`\\\`

**Key principles**:
1. Verify **structure**: FASTA format, valid bases, BsaI sites, annealing length.
2. Do NOT verify by reconstructing the assembled product from raw primers — enzymatic digestion changes the sequences.
3. If \`oligotm\` or primer3 is available, optionally check Tm of the annealing region.`,
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
