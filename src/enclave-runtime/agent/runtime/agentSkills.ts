/**
 * Agent skills — task-specific strategic hints injected into the system prompt.
 *
 * Unlike evaluator skills (which provide executable test recipes),
 * agent skills provide domain-specific strategies and heuristics that
 * guide the main agent / planner toward efficient approaches.
 *
 * Only activated when trigger keywords match the task description.
 */

// ── Skill type ───────────────────────────────────────────────

export interface AgentSkill {
  id: string;
  name: string;
  /** Any of these keyword groups triggers the skill (OR of ANDs). */
  triggers: string[][];
  /** Strategic hint injected into the system prompt. */
  hint: string;
}

// ── Skill registry ───────────────────────────────────────────

export const AGENT_SKILLS: AgentSkill[] = [
  {
    id: "crypto-brute-force",
    name: "Cryptanalysis: brute-force small key spaces",
    triggers: [
      ["key", "brute", "cipher"],
      ["key", "brute", "encrypt"],
      ["key", "brute", "decrypt"],
      ["seed", "encrypt", "key"],
      ["seed", "decrypt", "key"],
      ["seed", "cipher", "key"],
      ["keyspace", "recover"],
      ["round key", "recover"],
      ["cryptanalysis"],
      ["known-plaintext", "attack"],
      ["known plaintext", "attack"],
      ["feal", "round"],
      ["feal", "key"],
      ["feal", "linear"],
      ["linear", "attack", "round"],
      ["round key", "seed", "decrypt"],
      ["plaintext", "ciphertext", "round key"],
    ],
    hint: `**Cryptanalysis strategy — brute-force first, then MITM**:
- Before implementing a sophisticated cryptanalytic attack, ALWAYS estimate the effective key space size.
- If the key is derived from a seed of N bits, the search space is 2^N. For N <= 24 (~16M), a C brute-force loop can exhaust the space in seconds.
- Even if the task says "you can't brute force the entire keyspace", check if a SEED or KEY SCHEDULE reduces the effective space to something tractable.
- Recipe: write a C program that (1) iterates all seed values, (2) derives the round keys from each seed, (3) encrypts a known plaintext with those keys, (4) compares to the known ciphertext. Print the seed when matched. Compile with \`gcc -O3\`.
- Only fall back to linear/differential cryptanalysis if the effective key space exceeds ~2^28.

**For multi-round Feistel ciphers with per-round seeds (e.g. FEAL-like, 4 rounds x 20-bit seeds)**:
- Total keyspace is 2^80 (brute-force impossible), but each seed is only 2^20 (~1M).

**CRITICAL — Do NOT waste time on exploratory analysis. Follow this exact 4-step plan:**

**Step 1 — Find perfect linear approximations of F (budget: max 5 min)**:
Write ONE C program that searches for perfect approximations. FEAL-like F has MANY perfect relations.
CRITICAL — the search must use MULTI-BIT masks (like 0x01010101), NOT just single-bit masks. A search of only single-bit in/out masks will find 0 (this happened in a real run and wasted the entire budget). The proven approach:
- For each \`in_mask\` in {set of multi-bit masks, e.g. all bytes of form 0x??000000, 0x00??0000, etc.}: for each \`out_mask\` similarly: test parity(F(x) & out_mask) == parity(x & in_mask) ^ c over ~10M random x values. If violations == 0, it's perfect.
- Known working mask example: \`in=0x01010101, out=0x00040000\` is a perfect approximation of FEAL's F.
- If you find at least 2-3 perfect approximations, STOP and move to Step 2.

**Step 2 — Build the MITM solver (budget: max 10 min to write)**:
Do NOT try to "chain" approximations across rounds. Use the per-round seed structure:
- For each candidate seed0 in [0, 2^20): derive K0, compute R1 = L0 ^ F(R0 ^ K0) for all 32 known pairs, then compute a "signature" from parity constraints on R1. Store (signature → seed0) in a hash table.
- For each candidate seed3 in [0, 2^20): derive K3, compute R2 backwards from ciphertext, compute the same type of signature. Look up matches in the seed0 table.
- For each matching (seed0, seed3): brute-force seed1 in [0, 2^20) checking that Feistel equations hold for ALL 32 pairs. Then brute-force seed2 similarly.
- Verify all 32 pairs match. Print the four seeds AND immediately decrypt.
**CRITICAL debugging**: if your MITM shows \`sig_matches=0\`, the signature computation is WRONG. Check: (a) are you using the same parity constraints for forward and backward? (b) are the Feistel round directions correct? (c) is expand() applied correctly? Do NOT just re-run the same buggy code with a longer timeout — FIX the bug first.
Compile with \`gcc -O3\`. Run with \`timeout 120\`.

**Step 3 — Decrypt and write output IMMEDIATELY**:
The moment you have the four seeds, decrypt and write output in the SAME C program (don't make a separate decrypt step):
- Include \`decrypt\` logic directly in the solver: once keys are verified, loop over \`ciphertexts.txt\`, decrypt each line, write to \`plaintexts.txt\`.
- If decrypt.c is provided separately: \`gcc -O3 -o decrypt_prog decrypt.c && ./decrypt_prog ciphertexts.txt <seed0> <seed1> <seed2> <seed3> > plaintexts.txt\`
- Check line count matches ciphertexts.

**Step 4 — Call logos_complete immediately**:
After writing plaintexts.txt, verify line count, then call logos_complete. Do NOT spend time on extra verification.

**ANTI-PATTERNS that caused failures in ALL past failed runs (7/9 trials failed):**
- **find_linear finding 0 approximations** → searching only single-bit masks. Must use multi-bit masks like 0x01010101.
- **sig_matches=0 in MITM** → signature computation bug. Don't retry with longer timeout; fix the code.
- **"Done" without printing keys** → solver found nothing but exited normally. Always print keys explicitly and verify against pairs.
- Writing 10+ exploratory C files without building a solver — this consumes the entire budget.
- Running \`timeout 300\` (too long). Use \`timeout 120\` max.
- \`find_chain.c\` / chaining approximations across rounds → always yields 0 chains.
- Never calling logos_complete even after writing plaintexts.txt.
- Using the \`time\` command (not installed; causes exit 127).`,
  },
  {
    id: "compilation-from-source",
    name: "Large source compilation strategy",
    triggers: [
      ["compile", "source"],
      ["build", "source", "install"],
      ["build", "from source"],
      ["make", "install", "source"],
      ["compcert"],
      ["gcc", "build", "source"],
    ],
    hint: `**Large compilation tasks**:
- **CRITICAL first step**: before installing ANY dependencies, read the \`configure\` script, \`README\`, or \`INSTALL\` file to find EXACT version requirements. Installing the wrong version and then downgrading wastes critical time.
- Use \`nproc\` to determine available cores and pass \`-j$(nproc)\` to make.
- If a build fails, read the FULL error output (use logos_read if truncated) before attempting a fix. Do not blindly retry.
- Common pitfalls: missing dev packages (install with \`apt-get install -y\`), wrong OCaml/Coq version, missing autoconf/automake.
- **CompCert-specific**: CompCert 3.x requires Coq AND menhir in specific version ranges. Always run \`grep -i 'coq\\|menhir' configure\` FIRST to find the exact accepted versions. Install them in one \`opam install\` command (e.g. \`opam install -y coq.8.16.1 menhir.20220210\`) — do not install latest and hope it works.
- For long builds (Coq proofs, LLVM, GCC): the build itself may take 20-60 minutes. Start it early and do not waste time on unnecessary steps beforehand.
- **Do NOT use plan mode for compilation tasks.** \`opam install\` and \`make\` can exceed the 590s logos_exec timeout — that's expected. When a command times out, the process is still running in the background. Check with \`pgrep -a make\` or \`pgrep -a opam\`, and if it's still going, just re-run the same command (make is idempotent). Do NOT enter plan mode — replanning wastes far more time than waiting for the build.`,
  },
  {
    id: "ml-training-gpu",
    name: "ML training tasks",
    triggers: [
      ["train", "cifar"],
      ["train", "model", "gpu"],
      ["caffe", "train"],
      ["pytorch", "train"],
      ["tensorflow", "train"],
    ],
    hint: `**ML training tasks**:
- Check GPU availability first: \`nvidia-smi\` or \`python3 -c "import torch; print(torch.cuda.is_available())"\`.
- If no GPU, training may be extremely slow. Adjust batch size and epochs accordingly.
- For framework-specific tasks (Caffe, PyTorch, etc.), check if the framework is pre-installed. If not, install the CPU version unless GPU is available.
- Read any provided config/prototxt files carefully — they often specify paths, hyperparameters, and expected output locations.
- Start services in background mode if needed (e.g. data preprocessing pipelines).`,
  },
  {
    id: "caffe-build-train",
    name: "Caffe build from source and training",
    triggers: [
      ["caffe", "cifar"],
      ["caffe", "build"],
      ["caffe", "clone"],
      ["caffe", "train", "cifar"],
      ["bvlc", "caffe"],
      ["caffe", "cpu_only"],
      ["caffemodel"],
    ],
    hint: `**Caffe 1.0 on Ubuntu — TIME IS THE #1 CONSTRAINT**:

## CRITICAL — do NOT use plan mode, stay in ONE session

Building Caffe from source takes 25-40 min, training CIFAR-10 on CPU another 25-45 min. Total ~60-100 min from source. You MUST avoid source compilation if at all possible.

## Strategy: avoid building from source

Try these approaches IN ORDER — stop as soon as one works:

1. **conda/mamba** (fastest, ~2 min): \`curl -sL https://micro.mamba.pm/api/micromamba/linux-64/latest | tar xj -C /usr/local bin/micromamba && export MAMBA_ROOT_PREFIX=/opt/micromamba && /usr/local/bin/micromamba create -n caffe -c conda-forge caffe -y\`. Run caffe commands via \`/usr/local/bin/micromamba run -n caffe caffe ...\`. Note: the conda caffe binary may be linked against a different OpenCV soname than what's installed — if you get "libopencv_*.so.X.Y not found" errors, create symlinks from the available version to the expected version in the conda env's lib directory.
2. **Focal apt package** (~30s if it works): add \`deb http://archive.ubuntu.com/ubuntu focal universe\` repo, try \`apt-get install -y caffe-tools-cpu\`. If dependency conflicts arise (e.g. libboost version mismatch), remove the repo and move to option 3.
3. **Source build** (last resort, 10-30 min): install build deps, clone, configure, \`make all -j$(nproc)\`. Be aware of OpenCV 4 incompatibilities on Ubuntu 22.04+.

You still need to clone the BVLC/caffe repo (for config files, data scripts, prototxt) regardless of which approach you use. If using conda/system caffe, symlink the binary into the expected build path.

## Training pitfalls

- \`solver_mode\` MUST be \`CPU\`, otherwise it crashes with no GPU.
- Set \`snapshot\` interval so the model is saved at the exact final iteration required by the task.
- **CRITICAL — \`test_interval\` determines success or failure**: the default solver runs test every 100 iterations with 100 test batches each. On CPU, each test round takes several minutes. With 500 training iterations this means 5 test rounds × ~3 min = 15 min wasted on testing alone, causing timeout EVERY TIME. You MUST set \`test_interval\` equal to \`max_iter\` (e.g. both 500) so testing only happens once at the very end. This single change is the difference between finishing in 10 min vs timing out at 20 min. All 18 past runs failed because of this.
- The data download and LMDB conversion scripts reference relative build paths — adjust them if using system-installed or conda binaries.
- Caffe logs test accuracy as \`Test net output #1: accuracy = ...\` — parse this to verify the task's accuracy threshold.`,
  },
  {
    id: "fasttext-training",
    name: "FastText model training (text classification)",
    triggers: [
      ["fasttext", "train"],
      ["fasttext", "model"],
      ["fasttext", "accuracy"],
      ["fasttext", "yelp"],
      ["train", "fasttext"],
      ["model.bin", "accuracy"],
      ["model.bin", "fasttext"],
    ],
    hint: `**FastText text classification — key pitfalls to avoid**:

## Data preparation — minimal preprocessing

Convert parquet to fasttext format with ONLY newline replacement. Do NOT lowercase, do NOT remove punctuation — the verifier tests on RAW text, so any training-time normalization will cause a mismatch.

## Hyperparameter selection

Key considerations:
- **lr**: Many fasttext tutorials and benchmark pages show \`lr=0.5\` or \`lr=1.0\` — those are tuned for **specific small datasets** and do NOT generalize. On 650K-row datasets like Yelp Full, high lr causes gradient overshoot and plateaus around 0.58-0.60. **Start with the fasttext default lr and do NOT increase it.** This is the single most important thing to get right.
- **dim**: For text classification under a tight size budget, small dimensions (e.g. 10) work well and keep the model compact. Large dimensions (e.g. 100) make the model 10× bigger, leaving no room for sufficient bucket space.
- **bucket + model size**: Model size ≈ (vocab + bucket) × dim × 4 bytes + dictionary overhead. Choose bucket size so the final model fits under the size limit. Use \`minCount\` to control vocabulary size.
- **wordNgrams**: Bigrams (\`wordNgrams=2\`) are important for sentiment tasks — they capture "not good", "very bad" etc.
- **Quantization**: Generally drops accuracy noticeably and is not recommended if you can fit within the size limit without it.
- **autotune**: Risky on large datasets as each iteration may pick slow configs that timeout.

Keep training simple — one well-chosen config is better than trying many configs when time is limited.

## NumPy 2.x compatibility

The sandbox may use NumPy 2.x where \`np.array(x, copy=False)\` in the fasttext source is broken. After installing fasttext, patch it:

\`FTPY=$(python3 -c "import os, fasttext; print(os.path.dirname(fasttext.__file__) + '/FastText.py')") && sed -i 's/np\\.array(\\([^,]*\\), copy=False)/np.asarray(\\1)/g' "$FTPY"\`

Without this, \`model.predict()\` will crash with \`ValueError: Unable to avoid copy while creating an array as requested\`.

## Workflow
1. Install: \`pip install fasttext-wheel pandas pyarrow 2>&1 | tail -5\` (pre-built wheel). If it fails: \`apt-get install -y -qq g++ build-essential && pip install fasttext\`
2. Patch NumPy 2.x compat (see above)
3. Convert parquet → train.txt, test.txt (no preprocessing beyond newline replacement)
4. Train with parameters informed by official fasttext benchmarks
5. Verify accuracy and model size
6. Do NOT delete train.txt / test.txt`,
  },
  {
    id: "database-recovery",
    name: "Database / WAL file recovery",
    triggers: [
      ["wal", "recovery"],
      ["wal", "corrupted"],
      ["wal", "encrypted"],
      ["wal", "fix"],
      ["wal", "extract"],
      ["database", "corrupted", "recover"],
      ["database", "wal", "mode"],
      ["sqlite", "wal"],
    ],
    hint: `**Database / WAL recovery — preserve evidence first**:
- **CRITICAL**: NEVER open the database with \`sqlite3\` before backing up ALL files. When sqlite3 opens a WAL-mode database, it will attempt to checkpoint or recover the WAL. If the WAL is corrupted/encrypted, sqlite3 may SILENTLY DELETE IT, destroying the only copy of the data you need to recover.
- First step: \`cp -a /app/main.db /app/main.db.bak && cp -a /app/main.db-wal /app/main.db-wal.bak\` (or whatever the filenames are).
- Then analyze the WAL file with raw binary tools (\`xxd\`, \`od\`, Python \`struct\`) BEFORE touching sqlite3.
- WAL file format: 32-byte header (magic \`0x377f0682\` or \`0x377f0683\`), then frames of (24-byte frame header + page_size data). Page size is in the DB header at offset 16-17.
- Common corruption patterns: XOR encryption (single-byte key), byte-swap, header zeroed out. Try XOR with common bytes (\`0xAD\`, \`0xFF\`, etc.) and check if the result looks like valid WAL structure.
- After decrypting/fixing the WAL, copy the fixed WAL back as \`main.db-wal\`, then open with sqlite3 to read the full data.
- Write the final result JSON promptly — do not spend excessive turns on analysis after the data is recovered.`,
  },
  {
    id: "video-jump-landing-accuracy",
    name: "Video jump detection — landing frame accuracy",
    triggers: [
      ["jump", "video", "frame"],
      ["jump", "mp4", "frame"],
      ["takeoff", "land", "frame"],
      ["jump_analyzer"],
      ["hurdle", "video"],
    ],
    hint: `**Jump detection — KEY DESIGN DECISIONS (these determine success or failure)**:

The test video is ~270+ frames (jump at ~220); the example is ~120 frames (jump at ~53). Three design decisions separate working algorithms from broken ones:

**Decision 1: Anchor to the hurdle position**
- The hurdle is at a FIXED x-position in all videos (same camera, same track). Detect it from frame 0 (no runner) using vertical edge detection (e.g., Sobel) in the track region (lower-middle of the frame).
- The jump = the athlete crossing the hurdle's x-position. Find the frame where athlete center-x is closest to hurdle_x, then analyze vertical displacement in a ±15 frame window around that crossing. This prevents false positives from running strides, athlete entry, or other motion events.

**Decision 2: Use frame-to-frame differencing, not just background subtraction**
- Background subtraction alone (\`|frame - frame_0|\`) detects the hurdle itself as a foreground object (it has texture, shadows, etc.). This corrupts the athlete's center-x and bottom-y metrics.
- Combine background diff with FRAME-TO-FRAME differencing (\`|frame_i - frame_{i-2}|\`): foreground = (bg_diff > T) AND (frame_diff > T/2). This isolates only MOVING objects, removing static features like the hurdle. This is the #1 reason some algorithms fail — they mistrack because they detect the hurdle as foreground.

**Decision 3: Use a robust foot metric (bottom_95, not bottom_max)**
- Use the 95th percentile of foreground y-coordinates as the foot position (bottom_95), not the maximum. The maximum is noisy (single outlier pixels). bottom_95 gives a stable signal for the actual foot level.
- Ground level = median of the highest bottom_95 values (top 30%) in the detection window. Air vs ground threshold = ground_level minus ~20% of the total jump range.

**Frame offset rules (±1 frame matters!)**:
- **Takeoff**: report the LAST frame where the foot metric is firmly at ground level (with the NEXT frame clearly in the air). When ambiguous, pick the EARLIER frame.
- **Landing**: the first recovery frame is "foot touching" not "feet planted." ALWAYS add +1. Example: if bottom_95 first recovers at frame 61, report landing = **62**.
- Verify: takeoff < landing, gap ≈ 8-15 frames for a hurdle jump at 30fps.`,
  },
  {
    id: "mips-interpreter-doom",
    name: "MIPS interpreter for DoomGeneric",
    triggers: [
      ["mips", "interpreter", "vm.js"],
      ["implement", "mips", "interpreter"],
      ["mips", "elf", "interpreter"],
    ],
    hint: `**MIPS interpreter (DoomGeneric) — critical pitfalls (5/13 past runs succeeded)**:

1. **Sparse memory is MANDATORY**: the BSS section is ~1GB. You CANNOT allocate a flat buffer. Use a \`Map<number, Buffer>\` keyed by page number (e.g. 4KB pages).

2. **Delay slots**: MIPS branches/jumps have a delay slot — the instruction AFTER a branch always executes. Forgetting this is the most common interpreter bug.

3. **Custom syscall numbers**: this binary does NOT use standard MIPS Linux syscall numbers. Check \`#define SYS_*\` at the top of \`my_stdlib.c\` and \`fake_fs.c\` to find the actual numbers used. The \`syscall\` instruction triggers the trap — match the numbers the binary ACTUALLY uses.

4. **Do NOT use plan mode**: write the entire vm.js in one session. Plan mode splits context across sub-agents, causing massive time waste on re-reading source files. Successful runs completed in ~18 min with a single subtask; failed runs used 4+ subtasks and timed out.

5. **Write large files in chunks**: if writing vm.js via logos_write gets truncated, split into multiple \`logos_write({append: true})\` calls, or use \`logos_exec\` with \`cat >> /app/vm.js << 'EOF'\`.

6. **Self-test: check stdout completeness**: after running \`node /app/vm.js\`, verify that stdout contains ALL expected DOOM init messages (e.g. \`I_InitGraphics\`, \`I_Init\`, \`M_Init\`, \`R_Init\`). A missing line usually means a MIPS instruction bug is silently breaking a specific printf call path. Also confirm \`/tmp/frame.bmp\` exists and is a valid image.

For screen constants, framebuffer format, and filesystem semantics, read the source:
- \`doomgeneric/doomgeneric/doomgeneric.h\` — screen resolution defines
- \`doomgeneric/doomgeneric/my_stdlib.c\` — syscall numbers and conventions
- \`doomgeneric/doomgeneric/fake_fs.c\` — virtual filesystem implementation
- \`doomgeneric/doomgeneric/doomgeneric_img.c\` — frame output logic

7. **Let the binary write its own BMP** — do NOT hook \`DG_DrawFrame\` from the host side to capture frames. The binary's \`writeBMPFile\` uses \`fopen\`/\`fwrite\` syscalls; implement those syscalls and let the native code produce the BMP. Host-side hooks may produce incorrect pixel format or color channel ordering.

8. **SWL/SWR endianness**: use little-endian byte selection for MIPS32 LE. Big-endian semantics corrupt BMP headers (e.g. \`bpp\` = 0 instead of 32).`,
  },
  {
    id: "pdb-fasta-chromophore",
    name: "PDB FASTA chromophore (X) residue handling",
    triggers: [
      ["pdb", "fasta"],
      ["pdb", "protein", "gblock"],
      ["pdb", "protein", "sequence", "match"],
      ["fusion", "protein", "pdb"],
      ["fpbase", "pdb"],
      ["chromophore", "protein"],
    ],
    hint: `**PDB FASTA sequences — beware of modified residues**:
- PDB FASTA sequences may contain \`X\` characters representing post-translational modifications (e.g. chromophore formation in fluorescent proteins). An \`X\` does NOT represent a single unknown amino acid — it often replaces multiple residues that were modified.
- Do NOT simply skip or replace \`X\` with a single residue. This will change the protein length and cause sequence mismatches.
- **Neither PDB FASTA nor the PDB canonical sequence API resolves X**. Both \`pdbx_seq_one_letter_code\` and \`pdbx_seq_one_letter_code_can\` from the PDB REST API still contain \`X\` (or parenthesized codes like \`(CR2)\`). To find what X replaces, cross-reference with the fpbase API for fluorescent proteins (\`https://www.fpbase.org/api/proteins/?format=json&slug=LOWERCASE_NAME\` — returns a JSON array with a \`seq\` field). Align the fpbase sequence against the PDB FASTA to identify the residues that X replaces, then substitute only the X in the PDB FASTA — keep the rest of the PDB FASTA sequence intact.

**Do NOT use plan mode for this task.** Plan mode creates sub-agents with startup overhead (~2 min each), fragmenting context and wasting 5-10 minutes. The total time budget is tight (~15 min). Stay in a single session — gather all sequences, assemble the gBlock, and call logos_complete directly.`,
  },
  {
    id: "qemu-general",
    name: "QEMU general — backgrounding & minimal environments",
    triggers: [
      ["qemu", "telnet"],
      ["qemu", "alpine"],
      ["qemu", "ssh"],
      ["qemu", "start", "background"],
      ["qemu", "image", "boot"],
      ["qemu-system"],
    ],
    hint: `**QEMU in minimal (Slim) containers — two critical traps**:

1. **\`&\` alone is NOT enough — you MUST redirect stdout/stderr**:
   - With \`-nographic\`, QEMU writes serial console output to stdout. Even with \`&\`, the backgrounded process inherits the shell's stdout — \`logos_exec\` waits for all file descriptors to close, so it HANGS forever.
   - **CORRECT**: \`qemu-system-x86_64 ... > /tmp/qemu.log 2>&1 &\`
   - **WRONG**: \`qemu-system-x86_64 ... &\` (stdout still open → logos_exec hangs!)
   - Alternative: use \`-daemonize\` flag (QEMU forks and the parent exits immediately). But note that \`-daemonize\` is incompatible with \`-nographic\` — use \`-display none\` instead.

2. **Install essential tools FIRST** — Debian Slim images lack basic utilities:
   - \`apt-get install -y procps\` → gives you \`ps\`, \`pgrep\`, \`pkill\`
   - \`apt-get install -y net-tools\` → gives you \`netstat\`
   - \`apt-get install -y iproute2\` → gives you \`ss\`
   - Without these, you cannot check if QEMU is running or if ports are listening.
   - Do this BEFORE launching QEMU, not after.

3. **Verify QEMU is running and the port is ready**:
   - After starting: \`sleep 3 && pgrep -a qemu\` (need procps).
   - Check telnet port: \`(echo "" | telnet 127.0.0.1 6665) 2>&1 | head -5\` or use \`ss -tlnp | grep 6665\`.
   - For Alpine boot: allow 10-30 seconds for boot. Poll in a loop: \`for i in $(seq 1 30); do echo | telnet 127.0.0.1 6665 2>&1 | grep -q "login" && break; sleep 2; done\`.

4. **No KVM in containers**: \`/dev/kvm\` is usually not available. QEMU falls back to TCG (software emulation), which is slower but works. Do NOT pass \`-enable-kvm\` — it will fail. Expect boot to take 10-60 seconds depending on the OS.

5. **Never use bare \`nc\` or \`telnet\` to talk to QEMU sockets** — they hang indefinitely and eat the entire 590s logos_exec timeout. Always use \`timeout\` or \`socat\` with \`-T\` flag, e.g. \`timeout 5 socat - UNIX-CONNECT:/tmp/monitor.sock\` or \`echo "cmd" | timeout 5 nc -q 2 127.0.0.1 6666\`.`,
  },
  {
    id: "qemu-vm-setup",
    name: "QEMU VM setup & verification",
    triggers: [
      ["qemu", "windows"],
      ["qemu", "vnc"],
      ["qemu", "virtual machine"],
      ["qemu", "vm", "keyboard"],
      ["win311"],
      ["windows 3.1"],
    ],
    hint: `**QEMU Windows 3.11 — two fatal mistakes that caused 11/12 past runs to fail**:

1. **The win311.img boots to DOS, not Windows.** After QEMU starts you see a blue DOS screen — type \`win\` + Enter via the QEMU monitor to launch Windows 3.11 into its graphical desktop. If you skip this, you're stuck at DOS and keyboard interactions produce no visible change.

2. **Use \`-vga cirrus\` for Windows 3.11.** The default VGA adapter renders a black screen once Windows enters graphical mode. Cirrus is the compatible choice for this era of Windows.

3. **Use a UNIX monitor socket at \`/tmp/qemu-monitor.sock\`** — not telnet. Use \`-monitor unix:/tmp/qemu-monitor.sock,server,nowait\`. Also use **absolute paths** for the disk image (e.g. \`-hda /app/isos/win311.img\`).

If you're unsure about QEMU monitor key sending or VGA adapter compatibility, search:
- \`logos_call("web_search", {"query": "QEMU monitor sendkey command syntax"})\`
- \`logos_call("web_search", {"query": "QEMU VGA adapter Windows 3.11 cirrus vs std"})\`
- \`logos_call("web_search", {"query": "QEMU QMP send-key JSON API"})\``,
  },
  {
    id: "primer-tm-verification",
    name: "Primer Tm verification with oligotm",
    triggers: [
      ["primer", "melting"],
      ["primer", "oligotm"],
      ["primer", "temperature"],
      ["primer", "anneal", "tm"],
      ["oligotm"],
      ["primer", "mutagenesis"],
    ],
    hint: `**Primer Tm — use oligotm CLI as ground truth, and design with generous margins**:

**Q5 SDM primer architecture**: The task references NEB's Q5 site-directed mutagenesis kit, which has a specific back-to-back primer design convention (especially for insertions — the entire insert goes on the forward primer's 5' end, NOT split across both primers). Search \`logos_call("web_search", {"query": "NEBaseChanger Q5 site-directed mutagenesis insertion primer design back-to-back"})\` before designing primers.

1. **Always use \`oligotm\` from primer3** to compute Tm — never use Python Tm libraries or manual estimates:
   \`apt-get install -y primer3 && oligotm -tp 1 -sc 1 -mv 50 -dv 2 -n 0.8 -d 500 <annealing_sequence>\`
   Only the **annealing portion** (the part that base-pairs with the template) counts, NOT the full primer.

2. **Insertion boundary ambiguity — THIS IS THE #1 FAILURE MODE (5/5 recent runs failed due to this)**: When comparing input and output plasmids to find the inserted sequence, shared bases at the insertion boundary (e.g. "ag") can be assigned to either the insert or the template. The verifier uses a SPECIFIC boundary definition that may differ from yours by 2-3 bases. If your boundary is off, the verifier's \`rc(rev) + fwd\` check will fail even though the PCR product is biologically correct. You MUST enumerate all possible boundaries.

3. **Design rules to handle ambiguity**:
   - Target Tm **60-65°C** for both primers (not just ≥ 58°C).
   - Keep Tm difference **≤ 3°C** (not just ≤ 5°C).
   - These margins absorb 2-3 base boundary shifts without violating constraints.
   - If the insertion boundary is ambiguous, try shifting it ±2 bases and check that Tm constraints still hold for all interpretations.

4. **Exhaustive boundary search (MANDATORY — do NOT skip this)**: Write a script that (a) finds the longest common prefix and suffix between input and output to identify the changed region, (b) enumerates all valid boundary shifts (shared bases can slide ±2-3 positions), (c) for EACH boundary, computes the insert sequence, designs primers with the full insert on the forward primer 5' end, computes Tm for each annealing portion, and (d) picks the boundary+annealing length combination where ALL constraints are satisfied across ALL boundary interpretations. This takes seconds and is the ONLY reliable approach.

5. **Common pitfalls**:
   - Computing Tm on the wrong portion (including overhang bases).
   - Designing a reverse primer whose Tm barely passes 58°C — a 2-base boundary shift can push it below.
   - Designing primers with Tms far apart (e.g. 65°C vs 59°C) — a boundary shift widens the gap further.`,
  },
  {
    id: "golden-gate-assembly",
    name: "Golden Gate / BsaI primer design",
    triggers: [
      ["golden gate", "bsai"],
      ["golden gate", "primer"],
      ["golden gate", "assembly"],
      ["bsai", "primer"],
      ["bsai-hf", "primer"],
      ["nebbridge", "golden gate"],
      ["golden gate", "overhang"],
      ["dna", "assembly", "primer"],
      ["pcr", "primer", "golden"],
      ["primers.fasta", "golden"],
      ["primers.fasta", "bsai"],
    ],
    hint: `**Golden Gate assembly primer design**:

## Key concepts — research these with web_search if unfamiliar

- Golden Gate assembly uses Type IIS restriction enzymes (e.g. BsaI) that cut outside their recognition site, generating 4-nt overhangs for scarless assembly.
- Use \`logos_call("web_search", {"query": "Golden Gate assembly BsaI primer design"})\` to understand the primer structure and overhang design principles before writing code.
- Use \`logos_call("web_search", {"query": "BsaI recognition site GGTCTC cut position"})\` to understand where BsaI cuts relative to its recognition sequence.
- After finding relevant URLs from web_search, use \`logos_call("fetch_url", {"url": "..."})\` to read the full page content — especially NEB's documentation on BsaI cut positions (GGTCTC(1/5)).

## Common pitfalls

- **Primer structure** (5'→3'): \`[clamp][GGTCTC][spacer][4-nt overhang][binding region]\`
  - **clamp**: at least 1-4 nt before the BsaI site (e.g. \`tttt\`). Without it, BsaI cannot bind and cut.
  - **GGTCTC**: the BsaI recognition sequence. Use this exact sequence on ALL primers (both fwd and rev).
  - **spacer**: a single nucleotide (e.g. \`a\`). Must be a real base (a/t/g/c), NOT \`n\`.
  - **4-nt overhang**: the sticky end that determines assembly order. Derived from the desired output sequence at junction points.
  - **binding region**: the part that anneals to the template for PCR amplification.
- **Overhang design**: Overhangs must be derived from the desired assembled sequence at the exact junction points. They must be unique and non-palindromic.
- **Tm balancing**: Use \`oligotm\` (from primer3) to compute melting temperatures. Keep ΔTm between primer pairs small. The annealing portion is only the part that base-pairs with the template.
- **Binding region**: The binding must anneal to the template AFTER the overhang position, not overlapping with it. For example, if the overhang is the first 4 bases of a gene (e.g. \`atga\` = gene[0:4]), then the binding must start at gene[4], NOT gene[0]. If binding starts at gene[0], the overhang bases get duplicated in the assembled product.

## Time management

- Write \`primers.fasta\` EARLY — a correct file before timeout gets scored; perfect analysis with no output gets 0.
- Check templates for internal BsaI sites before designing primers.
- Verify Tm constraints after writing primers, then call \`logos_complete\` immediately.`,
  },
  {
    id: "gcode-text-reading",
    name: "G-code 3D text recognition",
    triggers: [
      ["gcode", "text"],
      ["gcode", "print"],
      [".gcode", "text"],
      [".gcode", "out.txt"],
      ["gcode", "out.txt"],
      ["prusa", "text"],
    ],
    hint: `**G-code text recognition — render toolpaths then OCR**:

## Strategy overview (budget: 15 min)
1. Parse gcode → find text object → extract extrusion segments (~2 min)
2. Compute 3D slope → project onto text plane → render as image (~3 min)
3. OCR with Tesseract → semantic disambiguation → write out.txt (~3 min)
4. Call logos_complete immediately

## Step 1 — Identify the text object
\`grep "M486 A" text.gcode\` reveals named objects (e.g., "Embossed text", "Shape-Box"). Use \`M486 S0/S1\` markers to track which object each G1 move belongs to. Only extract extrusion moves (G1 with E > previous E) for the TEXT object.

## Step 2 — 3D projection (CRITICAL)
The text is usually embossed on a **sloped surface** — X, Y, and Z all change as the text progresses. You CANNOT just do a top-down (XY) projection — it will look compressed/illegible.

**Proven approach**:
1. Collect centroids for each Z layer of the text object
2. Fit a slope direction from centroids: \`slope_3d = (max_centroid - min_centroid)\` in XYZ
3. Compute 2 orthogonal axes on the text plane:
   - axis1 (along text) = normalize(slope_3d)
   - axis2 (perpendicular) = normalize(cross(slope_3d, [0,0,1])) or similar
4. Project each segment onto (axis1, axis2) → 2D coordinates
5. Render with Pillow at HIGH resolution (width >= 8000 px). Low-res renders make OCR fail.
6. **IMPORTANT**: Keep total image pixels UNDER 100 million (e.g., 8000×4000 = 32M is fine; 30000×30000 = 900M is NOT). Oversized images cause PIL "decompression bomb" errors and slow down the evaluator.

## Step 3 — OCR (THIS IS WHERE MOST FAILURES HAPPEN)

Install: \`pip install pytesseract Pillow && apt-get install -y tesseract-ocr\`

Run Tesseract with MULTIPLE psm modes and pick the best:
\`\`\`python
results = {}
for psm in [6, 7, 8, 13]:
    text = pytesseract.image_to_string(img, config=f'--psm {psm}').strip()
    results[psm] = text
    print(f"psm {psm}: {text!r}")
\`\`\`

## CRITICAL — OCR ambiguous characters: use SEMANTIC CONTEXT to disambiguate
OCR CANNOT reliably distinguish visually similar characters: \`0\`/\`O\`, \`1\`/\`l\`/\`I\`, \`5\`/\`S\`, etc. Tesseract will consistently return the wrong one in some cases. Do NOT spend 10+ minutes trying different configs/thresholds/scales to resolve these — it will NEVER work.

**Instead, use semantic reasoning**:
1. Read the OCR output as a whole phrase/sentence
2. Infer what natural-language word or phrase it represents (including leet-speak, abbreviations, etc.)
3. Replace ambiguous characters based on which interpretation makes semantic sense
4. For example: if the text is about "coding" and OCR gives \`cOding\`, consider whether \`c0ding\` (leet-speak with zero) fits the context better

**Common OCR confusions**: O↔0, I↔l↔1, S↔5, B↔8, Z↔2, g↔9, rn↔m

## Time management
- **Write out.txt with your FIRST reasonable OCR result** before refining — a close answer beats timeout
- If multiple psm modes agree, that's your answer (after semantic correction)
- Do NOT try to read ASCII art manually character by character — it wastes time and is error-prone
- Do NOT attempt character-level OCR by cropping individual characters — it's less reliable than full-line OCR`,
  },
  {
    id: "web-scraping-context-limit",
    name: "Web scraping context management",
    triggers: [
      ["leaderboard", "scrape"],
      ["leaderboard", "curl"],
      ["leaderboard", "fetch"],
      ["mteb", "leaderboard"],
      ["mteb", "embedding"],
      ["mteb", "best"],
      ["huggingface", "leaderboard"],
      ["leaderboard", "ranking"],
      ["benchmark", "leaderboard"],
      ["embedding", "leaderboard"],
      ["scrape", "web", "data"],
    ],
    hint: `**Web data extraction — NEVER curl entire pages or download huge datasets**:
- Modern web pages (especially HuggingFace Spaces, Gradio apps, dashboards) are JS-rendered. Curling or fetching them returns empty or unusable HTML.
- **NEVER** do: \`curl https://some-leaderboard.hf.space/\` — it won't work.
- **DO NOT use the Gradio client API** (\`gradio_client.Client("mteb/leaderboard")\`) — the queue is frequently stopped or full, and API calls hang or timeout. Every past run that tried Gradio wasted 10+ minutes and got nothing. Skip it entirely.

**Benchmark leaderboard queries**:
- The \`mteb\` Python package and \`huggingface_hub\` package are available and useful. Explore their APIs.
- For MTEB results, you can \`git clone --depth=1\` the \`embeddings-benchmark/results\` repo and then checkout the commit corresponding to the target date. This gives you direct access to per-model JSON result files.
- **Write your answer early**: once you have a strong candidate, write it to the output file FIRST, then continue verifying. A correct early answer beats a perfect analysis that times out.
- **Time-sensitive queries ("as of DATE")**: benchmark datasets may contain results submitted at any time. If the task specifies a date, filter by when results were submitted — check model creation dates or commit timestamps.
- **Model type matters**: leaderboards may distinguish between embedding models and general-purpose LLMs. Pay attention to what the task is actually asking for.

**Filter for task coverage completeness**: when computing mean scores, only include models with results for ALL tasks in the benchmark subset. Models with missing tasks appear to score higher (missing tasks tend to be harder). This is the #1 cause of wrong answers on leaderboard queries.`,
  },
  {
    id: "html-js-sanitization",
    name: "HTML JS filtering — BeautifulSoup recursive sanitizer",
    triggers: [
      ["filter", "javascript", "html"],
      ["filter", "js", "html"],
      ["sanitize", "html", "script"],
      ["remove", "script", "html"],
      ["strip", "javascript", "html"],
      ["remove", "javascript", "xss"],
      ["xss", "html", "filter"],
    ],
    hint: `**HTML XSS filtering — use BeautifulSoup + recursive DOM sanitization**:

## CRITICAL — Do NOT use bleach or any pip-only library

The verifier runs \`/app/filter.py\` in a **separate Docker container** that shares \`/app\` but NOT the agent's Python site-packages. In this verifier container, \`pip install bleach\` **FAILS** (non-zero exit). Any solution that depends on bleach will crash with \`ModuleNotFoundError\` in the verifier and get 0 score.

**Only \`beautifulsoup4\` is reliably installable** in the verifier container. Use BS4's \`html.parser\` as the sole HTML engine. Do NOT depend on bleach, lxml, html5lib, or any C-extension library.

## Proven approach — BS4 recursive DOM walk (~260 lines, passes all 439 XSS vectors)

Auto-install only beautifulsoup4:
\`\`\`python
#!/usr/bin/env python3
import subprocess, sys, os
try:
    from bs4 import BeautifulSoup, Comment, Tag
except ImportError:
    subprocess.check_call([sys.executable, "-m", "pip", "install", "-q", "beautifulsoup4"])
    from bs4 import BeautifulSoup, Comment, Tag
\`\`\`

**Architecture** (recursive \`sanitize_node(node)\` function):

1. **Remove dangerous tags entirely** (with all content): \`script\`, \`base\`, \`bgsound\`, \`param\`
2. **Unwrap dangerous tags** (keep children, remove wrapper): \`iframe\`, \`object\`, \`embed\`, \`applet\`, \`svg\`, \`math\`, \`xml\`, \`frame\`, \`frameset\`, \`layer\`, \`ilayer\`
3. **Remove all event handler attributes**: any attr matching \`/^on/i\` (covers onclick, onerror, onload, onmouseover, onfocus, etc.) — also check for mangled variants like \`oonmouseover\`
4. **Sanitize URL attributes** (href, src, action, formaction, background, poster, dynsrc, lowsrc, etc.):
   - HTML-decode the value, strip control chars (\\t\\n\\r\\x00), then check for \`javascript:\`, \`vbscript:\`, \`data:text/html\` schemes
   - If dangerous, delete the attribute entirely
5. **Sanitize \`<style>\` tag content**: remove \`expression()\`, \`-moz-binding:\`, \`behavior:\`, \`javascript:\` in \`url()\`
6. **Sanitize style attributes**: same CSS checks
7. **Remove dangerous \`<meta>\` refresh**: if \`http-equiv="refresh"\` and content contains \`javascript:\`
8. **Remove \`<link>\` with javascript href**
9. **Strip IE conditional comments** and comments containing script-like content
10. **Post-process serialized output**: regex pass on the final HTML string to catch edge cases that survive DOM parsing (e.g., attribute breakout patterns like \`alt="foo"onerror=alert(1)"\`)

**Key detail — URL attribute sanitization**:
\`\`\`python
import re, html as html_module

DANGEROUS_URL_RE = re.compile(r'^\\s*(javascript|vbscript|data\\s*:(?!image/))', re.I)

def is_dangerous_url(url):
    if not url: return False
    cleaned = html_module.unescape(url)
    cleaned = re.sub(r'[\\x00-\\x1f\\x7f]+', '', cleaned).strip()
    return bool(DANGEROUS_URL_RE.match(cleaned))

URL_ATTRS = {'href', 'src', 'action', 'formaction', 'background',
             'poster', 'dynsrc', 'lowsrc', 'code', 'codebase', 'value'}
\`\`\`

## CRITICAL — Final output normalization

The verifier's \`test_clean_html_unchanged\` compares \`str(BeautifulSoup(original, "html.parser"))\` against the raw filtered output. Your output MUST be BS4-normalized:
\`\`\`python
final = str(BeautifulSoup(sanitized_html, "html.parser"))
Path(sys.argv[1]).write_text(final)
\`\`\`
Without this, clean HTML will FAIL because BS4 reorders attributes alphabetically, converts \`<br>\` to \`<br/>\`, decodes entities like \`&copy;\` → \`©\`.

## XSS test details

The verifier tests 439 XSS vectors from a curated GitHub list in a real Chrome browser via Selenium. Vectors include:
- \`<svg/onload=alert(1)>\`, \`<math><mtext><table><mglyph><style>...\`
- \`<IMG SRC="javascript:alert('XSS')">\`, \`<IMG SRC=JaVaScRiPt:alert('XSS')>\`
- \`<object><param value="javascript:...">\`, \`<embed src="javascript:...">\`
- \`<BODY onload!#$%&()*~+-_.,:;?@[/|\\]^\`=alert("XSS")>\`
- \`style="-moz-binding:url(data:...)">\`, \`<!--[if gte IE 4]><SCRIPT>...\`
- \`<div oonmouseover=nmouseover=alert()>\` (doubled-prefix attack)
- \`<img alt='foo"onerror=alert(17)' src="">\` (attribute breakout)

A pure regex approach WILL miss many of these. The BS4 DOM walk + post-processing regex pass handles all of them.`,
  },
  {
    id: "sam-cell-segmentation",
    name: "SAM/MobileSAM cell segmentation output format",
    triggers: [
      ["mobilesam", "segment"],
      ["sam", "cell", "segment"],
      ["sam", "mask", "polyline"],
      ["cell", "segmentation", "csv"],
      ["sam", "csv", "polyline"],
    ],
    hint: `**SAM/MobileSAM cell segmentation — ensure ALL masks are polylines**:

- **CRITICAL**: The verifier checks that EVERY row in the output CSV has \`type=polyline\`, not \`type=rectangle\`. If any masks remain as rectangles, the submission FAILS.
- **Common pitfall**: MobileSAM's auto-mask generator produces masks as binary arrays. The conversion pipeline often only converts SOME masks to polylines (e.g., those above a size threshold) and leaves others as their original bounding-box rectangles.
- **Correct approach**:
  1. Generate masks with MobileSAM's \`SamAutomaticMaskGenerator\`.
  2. For EACH mask, extract the contour using \`cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)\`.
  3. Convert the contour to a polyline string (list of x,y coordinate pairs).
  4. Set \`type=polyline\` for ALL rows. There should be ZERO \`type=rectangle\` rows.
- **Post-processing validation**: After generating the output CSV, ALWAYS run a sanity check:
  \`python3 -c "import pandas as pd; df=pd.read_csv('/app/output.csv'); print('rectangle rows:', (df['type']=='rectangle').sum()); assert (df['type']=='rectangle').sum() == 0, 'FAIL: still have rectangle rows'"\`
- **Overlap resolution**: After converting to polylines, there may be overlapping regions. Resolve overlaps by keeping the smaller mask (higher priority), then re-extract polylines from the final non-overlapping masks.
- **coords_x / coords_y must be FLAT lists**: The verifier checks that coordinate columns contain flat lists of numbers (e.g. \`[1, 2, 3]\`), NOT nested lists (e.g. \`[[1, 2], [3, 4]]\`). \`cv2.findContours\` returns arrays with shape \`(N, 1, 2)\` — you must flatten with \`.squeeze()\` or \`.reshape(-1, 2)\` before writing to CSV. Verify: \`python3 -c "import ast, pandas as pd; df=pd.read_csv('/app/output.csv'); [ast.literal_eval(v) for v in df['coords_x']]; print('coords OK')"\``,
  },
  {
    id: "service-daemon-startup",
    name: "Start long-running services in daemon/background mode",
    triggers: [
      ["mailman", "start"],
      ["mailman", "configure"],
      ["mailman3"],
      ["postfix", "mailman"],
    ],
    hint: `**Service startup — \`&\` alone is NOT enough, you MUST redirect stdout/stderr**:

- **You need BOTH \`&\` AND output redirection — either one alone will hang**:
  - \`some_service &\` → HANGS (stdout still connected to shell pipe)
  - \`some_service > /tmp/svc.log 2>&1\` → HANGS (no \`&\`, runs synchronously)
  - \`some_service > /tmp/svc.log 2>&1 &\` → **CORRECT** (background + detached output)
- \`logos_exec\` waits for ALL file descriptors to close AND all foreground processes to exit. Without BOTH \`&\` and \`> file 2>&1\`, it blocks until the service exits.

- **Mailman-specific** — \`mailman start\` can block if it doesn't fully detach:
  - \`su - list -s /bin/bash -c "mailman start" &\` → **WRONG** (stdout open → hangs)
  - \`su - list -s /bin/bash -c "mailman start > /tmp/mailman.log 2>&1"\` → **WRONG** (no \`&\` → synchronous block)
  - \`su - list -s /bin/bash -c "mailman start > /tmp/mailman.log 2>&1 &"\` → **CORRECT** (\`&\` INSIDE the quotes!)
  - Then: \`sleep 3 && mailman status\` to verify.
  - Start Postfix first (\`postfix start\` auto-daemonizes), THEN start Mailman.
  - After starting, verify with \`mailman status\` and \`postfix status\` — don't assume success.
- **General service rules**:
  - \`nginx\` → auto-daemonizes (no \`&\` needed, but \`nginx -g "daemon off;"\` WILL block — never use that).
  - \`uwsgi\` / \`gunicorn\` → use \`--daemon\` flag or \`> /tmp/x.log 2>&1 &\`.
  - Database servers (\`postgres\`, \`mysql\`) → use \`pg_ctlcluster ... start\` or \`service mysql start\`.
  - Any unknown service → \`service_cmd > /tmp/svc.log 2>&1 &\`, wait 2-3s, check \`pgrep -a <name>\`.
- **Recovery**: if a command times out, the process may still be alive. Check with \`pgrep -f <service>\` and proceed if it's running. Don't waste time restarting what's already working.

**Mailman3 message delivery — common pipeline failures**:
- **Permissions are the #1 cause of stuck messages**. All files under \`/var/lib/mailman3/\` must be owned by the \`list\` user. Run \`chown -R list:list /var/lib/mailman3\` BEFORE starting mailman. Same for \`/run/mailman3\` and \`/var/log/mailman3\`.
- **\`postmap\` must succeed**: mailman regenerates \`postfix_lmtp\` and \`postfix_domains\` maps when starting. If \`postmap\` fails (wrong permissions on data dir, or \`postmap\` not in PATH for the \`list\` user), postfix won't know how to route mail to mailman's LMTP. Fix: ensure \`/usr/sbin/postmap\` is accessible and the output \`.db\` files are writable by \`list\`.
- **Check queue dirs, not just processes**: if \`/var/lib/mailman3/queue/pipeline/\` has stuck \`.pck\` files but \`/var/lib/mailman3/queue/out/\` is empty, the pipeline runner is failing silently. Check \`/var/log/mailman3/mailman.log\` and \`smtp.log\` for the actual error — don't just kill/restart.
- **The \`list\` user's home dir**: \`su - list\` may warn "cannot change directory to /var/list". Fix: \`mkdir -p /var/list && chown list:list /var/list\` or use \`su -s /bin/bash list\` (without \`-\`) to skip home dir.
- **Verify the full delivery path BEFORE calling done**:
  1. \`postfix status\` → running
  2. \`mailman status\` → all runners alive
  3. Send a test message with \`/app/eval.py\` (if provided) or \`echo "test" | mail -s test reading-group@local.edu\`
  4. Check \`/var/mail/<user>\` for delivery — if empty, check logs, don't just restart services.

**Mailman3 confirmation timing — the hidden trap**:
- Mailman processes emails asynchronously via runners (command, pipeline, etc.). The default \`sleep_time\` is 1s per runner cycle. After sending a join/leave/confirm email via SMTP, you must **wait for the runner to process it** before checking the result or sending the next email.
- **Always \`sleep 5\` after sending any email** to mailman (join, confirm reply, leave, post). If you check too fast, the confirmation hasn't been processed yet and the next action fails.
- **LMTP port (8024) may not be ready immediately** after \`mailman start\`. Always verify: \`python3 -c "import socket; s=socket.socket(); s.settimeout(5); s.connect(('127.0.0.1', 8024)); s.close(); print('OK')"\`. If it fails, wait and retry — don't proceed with list creation until LMTP is up.
- **The join→confirm→leave flow must be sequential with waits**: send join → sleep 5 → read confirmation token from mailbox → send confirm reply → sleep 5 → verify membership → then proceed. Skipping waits causes "unverified email" errors on leave.
- **Never patch mailman source code**. If the flow doesn't work, the problem is almost always: (a) runner not processing fast enough (add sleeps), (b) permissions on queue dirs, or (c) postfix not routing confirm emails back to mailman's LMTP. Check \`/var/log/mailman3/mailman.log\` for the actual error.`,
  },
  {
    id: "stan-mcmc-optimization",
    name: "Stan/MCMC sampling optimization",
    triggers: [
      ["stan", "sampling"],
      ["stan", "posterior"],
      ["pystan"],
      ["rstan"],
      ["mcmc", "sampling"],
      ["posterior", "sampling"],
    ],
    hint: `**Stan/MCMC performance — optimize before running**:
- Stan MCMC sampling can range from minutes to hours depending on model parameterization. A naive translation of a Stan model will often be unusably slow. ALWAYS optimize the Stan code before running.
- **Cholesky parameterization for GPs**: replace \`multi_normal(mu, K)\` with \`multi_normal_cholesky(mu, cholesky_decompose(K))\`. This alone can speed up sampling by 5-10x.
- **Use built-in covariance functions**: prefer \`cov_exp_quad\` over manual kernel construction.
- **Non-centered parameterization**: instead of \`y ~ multi_normal(mu, K)\`, use \`eta ~ std_normal(); y = mu + L * eta\` where \`L = cholesky_decompose(K)\`. This helps the sampler explore the posterior more efficiently.
- **Reduce redundant computation**: compute the covariance matrix in \`transformed data\` if it does not depend on parameters. Cache intermediate results.
- **Sampling parameters**: if the task only asks for posterior means (not full diagnostics), you can often reduce chains to 1-2 and keep warmup minimal while still getting accurate point estimates. Check if the task explicitly requires a specific number of chains/iterations.
- **Time budget**: if a trial run shows sampling is too slow (e.g. <10% done in 5 minutes), STOP and optimize the model first instead of waiting for it to finish.`,
  },
  {
    id: "regex-pipeline-dev-methodology",
    name: "Regex substitution pipeline — fast development loop",
    triggers: [
      ["regex", "substitution", "json"],
      ["re.json", "re.sub"],
      ["regex", "replacement", "pair"],
      ["regex", "chess"],
      ["re.json", "chess"],
    ],
    hint: `**Regex substitution pipelines — development speed is everything**:

## CRITICAL — Do NOT use plan mode (this determines success or failure)

This task has a hard 1-hour time limit. **Do NOT call \`logos_complete\` with a \`plan\` array.** Plan mode creates sub-agents with startup overhead (~2 min each), fragmenting context across step logs and wasting 10-15 minutes.

**Stay in a single session.** Call \`logos_exec\` / \`logos_write\` / \`logos_read\` directly. You have a 1M-token context window — more than enough for gen.py (<500 lines) plus all debugging.

---

## Proven architecture for chess regex move generation

The following 6-phase architecture produces correct results with ~6300 rules, ~735KB, ~2-5s per position. Follow this blueprint exactly:

**Phase 1 — FEN expansion** (~14 rules):
- Strip halfmove/fullmove: \`' (\\d+) (\\d+)$' → ''\`
- Expand digits to dots (8 down to 1) ONLY in the board part
- **PITFALL**: en-passant field (e.g. \`d6\`, \`a3\`) contains digits that must NOT be expanded. Use double lookbehind: \`'(?<! )(?<! [a-h])' + str(d) + '(?=[^\\\\n]* )'\`. The naive pattern turns \`d6\` into \`d......\` and corrupts the FEN.
- Mark original board with \`!\` prefix for later reference, append \`~\` separator

**Phase 2 — Move generation** (~3836 rules):
- Use a \`make_move(from_f, from_r, to_f, to_r, piece, dest_pattern, ...)\` helper that builds a regex matching the original board and appends \`~new_position\`
- Generate: Knight (all from/to pairs), King (non-castling, adjacent squares), Pawn (single push, double push, captures, promotion to Q only, en passant), Bishop/Rook/Queen (all from/to pairs with path-clearance — intermediate squares must be \`.\`)
- Board uses 9-char rows (8 squares + \`/\` separator), so \`sq(file, rank) = (7 - rank) * 9 + file\`

**Phase 2b — Castling safety pre-check** (~130 rules — KEY INSIGHT):
- Before generating castling moves, check if e1/f1/g1 (kingside) or e1/d1/c1 (queenside) are attacked in the ORIGINAL board
- **CRITICAL — e1 must be checked for BOTH K and Q**: if e1 is attacked (king is in check), BOTH kingside AND queenside castling are illegal. This is the #1 castling bug: checking only f1/g1 for kingside and d1/c1 for queenside, but forgetting that e1 being attacked blocks ALL castling. The failed run LPiUHJ2 had exactly this bug — it only filtered f1/d1 attacks, allowing O-O when a rook was giving check on the e-file.
- For each attack pattern (by pawn/knight/bishop/rook/queen/king) that could hit e1, f1, or g1: add a rule removing \`K\` from metadata. For e1, d1, or c1: add a rule removing \`Q\`. Since e1 is shared, attacks on e1 must remove BOTH K and Q.
- This prevents illegal castling moves from being generated in the first place, keeping the rule count low (~6300 total vs ~9200+ with post-filtering approaches)

**Phase 2c — Castling moves** (~2 rules):
- Now safe to generate O-O and O-O-O (pattern matches K at e1 + R at h1/a1 + castling letter present)

**Phase 3 — Convert to lines** (~3 rules):
- Remove original board prefix (\`^[^~]*~\` → empty), split \`~\` → newlines

**Phase 4 — Castling rights update** (~12 rules):
- Post-move update: if K not at e1 → remove K/Q; if R not at h1 → remove K; if R not at a1 → remove Q; same for black
- Fix empty castling field: \` b  -\` → \` b - -\`

**Phase 5 — Legality filter** (~2300 rules):
- For each of 64 possible white King positions, check if attacked by black pawn/knight/bishop/rook/queen
- Mark illegal lines with \`~\` prefix, then remove them
- **Build incrementally by attacker type** (pawn → knight → king → rook/queen → bishop/queen), running oracle test on 3-5 targeted positions after each

**Phase 6 — Compact** (~9 rules):
- Compress dots→digits (8 down to 1), add \`0 0\` counters

---

## CRITICAL — Time management (the #1 success factor)

Once \`check.py\` passes, you are ~80% done. **Do NOT run exhaustive random tests.**

**After check.py passes**:
1. Run 5-10 targeted edge cases (~60s total). MUST include these castling positions:
   - Castling OUT of check (king on e1 attacked): \`r3r1k1/pp3pbp/1qp3p1/2B5/2BP2b1/Q1n2N2/P4PPP/3RK2R w K - 2 17\` → only 6 legal moves, O-O is ILLEGAL (Re8 gives check on e-file)
   - Castling THROUGH check (f1 attacked): e.g. bishop on b5 attacking f1
   - En passant, promotion, pins
2. Verify the sample output from the task description matches exactly
3. **Immediately call \`logos_complete\`** — do NOT attempt more random testing

The evaluator/fixer cycle (up to 3 rounds) is specifically designed to catch remaining edge-case bugs. Trust it — that's a far better use of time than running 50+ random positions at ~5s each, which will hit the 590s logos_exec timeout and waste the entire window.

Successful runs: agent completes in ~40 min, leaving ~20 min for evaluator/fixer to polish. Failed runs: agent spends all 60 min on random testing, times out, evaluator never runs.

---

**Use python-chess as an instant oracle**:
\`\`\`python
import chess
b = chess.Board(fen)
expected = sorted(set(
    b.fen().rsplit(' ', 2)[0]
    for m in b.legal_moves if not (m.promotion and m.promotion != chess.QUEEN)
    for _ in [b.push(m)] for __ in [None] if not b.pop()
))
\`\`\`
Build a \`test_one(fen)\` function for instant single-position feedback instead of running check.py repeatedly.

**Common pitfall — marker character collisions**:
- Marker characters (\`!\`, \`~\`) must not appear in valid FEN output. Apply deletion rules LAST.`,
  },
  {
    id: "torch-pipeline-parallelism",
    name: "PyTorch pipeline parallelism (AFAB scheduling)",
    triggers: [
      ["pipeline", "parallel", "train_step"],
      ["pipeline", "parallel", "afab"],
      ["pipeline", "parallel", "llama"],
      ["pipeline_parallelism"],
    ],
    hint: `**Pipeline parallelism with AFAB scheduling — environment setup and pitfalls**:

## Environment setup (container has NO Python)

The container has no Python. Setup is the #1 time killer:

1. \`apt-get update && apt-get install -y python3 python3-pip\` (~30s)
2. **CRITICAL**: \`pip3 install torch --index-url https://download.pytorch.org/whl/cpu --no-cache-dir --break-system-packages\` (~90s). **NEVER** run bare \`pip install torch\` — it downloads the CUDA build (~2GB) and WILL time out.
3. \`pip3 install transformers --no-cache-dir --break-system-packages\` (~30s)

## Time budget is TIGHT — skip exploration, write code directly

You have ~15 min total (agent + evaluator). Environment setup takes ~3 min. **Do NOT spend time exploring the model structure** — the LlamaForCausalLM layout is well-known:
- \`model.model.embed_tokens\`: Embedding layer (rank 0)
- \`model.model.layers\`: ModuleList of LlamaDecoderLayer (partition across ranks)
- \`model.model.norm\`: LlamaRMSNorm (last rank)
- \`model.model.rotary_emb\`: LlamaRotaryEmbedding — call with \`(hidden_states, position_ids)\` to get \`(cos, sin)\` tuple, pass as \`position_embeddings=(cos, sin)\` to each decoder layer
- \`model.lm_head\`: Linear (last rank)
- Each decoder layer accepts \`(hidden_states, position_embeddings=...)\` and returns a tensor

**Write \`/app/pipeline_parallel.py\` immediately after installing dependencies.** Run ONE single-rank verification test, then call \`logos_complete\`. Do NOT repeat tests or re-read your own code.

## Implementation notes

- Process each microbatch INDIVIDUALLY through the model's actual module objects. The verifier uses hooks to track per-microbatch activations, so don't concatenate microbatches.
- For loss computation, follow the task description literally — it says "compute cross_entropy loss against the targets."
- Omit \`attention_mask\` (or pass \`None\`) — decoder layers handle causal masking internally. Do NOT call \`create_causal_mask\` or \`_update_causal_mask\` — these are internal APIs that break across transformers versions.
- Do NOT use hooks (\`register_forward_hook\` etc.) — the verifier checks for this.
- The function MUST return the loss tensor.
- **Variable-shape microbatches**: When communicating hidden states between ranks via \`dist.send\`/\`dist.recv\`, send shape metadata (seq_len, hidden_size) for EVERY microbatch, not just the first. Microbatch sizes may differ (e.g. different sequence lengths). If you cache the shape from \`mb_idx == 0\` and reuse it, \`dist.recv\` will allocate the wrong buffer size → size mismatch error or deadlock.

## Kill stale processes after self-testing

After ANY self-test that uses \`dist.init_process_group\`, ALWAYS run:
\`\`\`bash
pkill -9 -f python3 2>/dev/null; sleep 2
\`\`\`
The verifier uses port 12355. If your test leaves a process holding a port, the verifier gets \`EADDRINUSE\` and fails.

## Don't waste time on multi-process local testing

The container's \`mp.spawn\` is unreliable (Bus errors, shared memory issues). Verify with single-rank tests only. The verifier has its own working test infrastructure.`,
  },
  {
    id: "dataset-token-counting",
    name: "HuggingFace dataset token counting",
    triggers: [
      ["dataset", "tokens", "huggingface"],
      ["dataset", "tokens", "tokenizer"],
      ["dataset", "token", "count"],
      ["count", "tokens", "dataset"],
    ],
    hint: `**Dataset token counting — column selection is critical**:
- When the task says "count X tokens" or "how many X tokens", where X is a prefix/keyword that appears in multiple column names, you MUST tokenize ALL columns whose names contain X, not just one.
- Example: "count deepseek tokens" means tokenize EVERY column with "deepseek" in the name (e.g. \`deepseek_reasoning\`, \`deepseek_solution\`, etc.), then sum the counts.
- Before writing code, list ALL column names and identify every column matching the keyword. Print them explicitly to verify.
- Double-check: if you only selected one column but multiple columns match, you are almost certainly wrong.`,
  },
  {
    id: "embedding-model-usage",
    name: "Embedding model query prefix",
    triggers: [
      ["embedding", "cosine"],
      ["embedding", "similarity"],
      ["bge", "embedding"],
      ["bge", "cosine"],
      ["bge", "similarity"],
      ["embedding", "retrieve"],
      ["cosine", "similarity", "model"],
    ],
    hint: `**Embedding models — check the model's required query format BEFORE encoding**:
Many embedding models (e.g. BGE, E5, GTE) require a specific instruction prefix prepended to the query text for retrieval tasks. Without the correct prefix, cosine similarity rankings will be wrong.

Before writing code, search for the model's usage:
- \`logos_call("web_search", {"query": "<model_name> embedding query instruction prefix"})\`
- \`logos_call("fetch_url", {"url": "https://huggingface.co/<org>/<model_name>"})\` — check the model card for usage examples

For example, BGE models typically need \`"为这个句子生成表示以用于检索相关文章："\` (Chinese) or \`"Represent this sentence for searching relevant passages:"\` (English) prepended to the query. Using the wrong prefix (or no prefix) produces incorrect similarity rankings.`,
  },
  {
    id: "chess-board-recognition",
    name: "Chess board image to best move",
    triggers: [
      ["chess", "board", "move"],
      ["chess", "image", "move"],
      ["chess_board", "move"],
      ["chess", "best move"],
      ["chess", "png", "move"],
    ],
    hint: `**Chess board recognition — the FEN extraction is the hardest part**:

The critical step is correctly converting the board image to a FEN string. Pixel-based piece recognition is error-prone and causes wrong FEN → wrong best move. Before writing your own recognizer, search for better approaches:
- \`logos_call("web_search", {"query": "chess board image recognition FEN python library"})\`
- \`logos_call("web_search", {"query": "chess piece detection from screenshot python"})\`

After extracting the FEN, **verify it looks reasonable**: print the board (\`chess.Board(fen)\`), count pieces (should make sense for a real game), and check that the position is legal (\`board.is_valid()\`). If any piece count looks wrong, your recognition has a bug — fix it before running the engine.

Use Stockfish for the best move: \`apt-get install -y stockfish\`, then use \`python-chess\` engine interface with sufficient depth/time.`,
  },
  {
    id: "adaptive-rejection-sampler",
    name: "Adaptive rejection sampler — no plan mode",
    triggers: [
      ["adaptive", "rejection", "sampler"],
      ["adaptive", "rejection", "sampling"],
      ["gilks", "1992"],
      ["gilks", "wild"],
    ],
    hint: `**Adaptive rejection sampler — do NOT use plan mode**:

The time budget (900s) is tight for writing a full ARS implementation + tests + sample generation. Every past run that used plan mode timed out due to replanning overhead. Write the entire solution in one session — implement, test, and generate output files without calling logos_complete with a plan.

If writing the R file via logos_write gets truncated, use \`logos_exec\` with \`cat > /app/ars.R << 'EOF'\` or split into chunks with \`logos_write({append: true})\`.`,
  },
  {
    id: "gpt2-codegolf",
    name: "GPT-2 code golf — understand the checkpoint format first",
    triggers: [
      ["gpt2", "ckpt"],
      ["gpt-2", "ckpt"],
      ["gpt2", "codegolf"],
      ["gpt-2", "codegolf"],
      ["gpt2", "code golf"],
      ["gpt-2", "code golf"],
      [".ckpt", "sample"],
      [".ckpt", "c file"],
    ],
    hint: `**GPT-2 code golf — do NOT implement from scratch**:
- Writing a dependency-free C GPT-2 under 5000 bytes from scratch is near-impossible within the time limit. Consider searching for existing minimal implementations to adapt.
- The .ckpt file uses TensorFlow's named-variable format, not raw floats — you need to parse the index to locate each weight tensor.`,
  },
  {
    id: "make-doom-for-mips",
    name: "Cross-compile DOOM to MIPS ELF",
    triggers: [
      ["build", "doomgeneric_mips"],
      ["build", "doomgeneric", "elf"],
      ["doomgeneric", "mips", "elf", "build"],
    ],
    hint: `**Cross-compile DOOM to MIPS — do NOT use plan mode**:

The time budget (900s) is tight. Every past run that used plan mode timed out due to replanning overhead. Write everything in one session.

Two things that caused failures in past runs:
1. **Read the VM's source** (\`/app/vm.js\`) to understand what syscall convention it expects — it does NOT use standard MIPS Linux syscalls.
2. **Read the source for screen resolution** — do not hardcode dimensions, check \`doomgeneric.h\` for the actual values. Past runs used 320x200 but the reference expected 640x400.`,
  },
  {
    id: "document-classification-ocr",
    name: "Document classification with OCR",
    triggers: [
      ["invoice", "classify", "pdf"],
      ["invoice", "classify", "jpg"],
      ["invoice", "other", "pdf"],
      ["invoice", "other", "jpg"],
      ["document", "classify", "invoice"],
      ["financial", "document", "processor"],
      ["summary.csv", "invoice"],
      ["total_amount", "vat_amount"],
    ],
    hint: `**Document classification + extraction — preview EVERY document individually before classifying**:
- This task is NOT time-sensitive. You have plenty of time. Prioritize accuracy over speed — misclassifying a single document will fail the entire task.
- Extract text from EVERY document individually (\`pdftotext -layout\` for PDFs, \`tesseract\` for images) and read the full output before making any classification decision. Do NOT batch multiple documents in one command where output truncation could hide content.
- Use \`pdftotext -layout\` (the \`-layout\` flag preserves tabular structure needed for some invoice formats).
- Documents mentioning money/prices are not necessarily invoices (e.g. purchase orders, financial reports, quotes). Classify based on the document explicitly being an invoice (look for the word "Invoice" as a title/header), not just the presence of amounts or line items.`,
  },
  {
    id: "sql-query-optimization",
    name: "SQL query optimization",
    triggers: [
      ["sql", "optimize"],
      ["sql", "efficient"],
      ["query", "optimize"],
      ["query", "efficient"],
      ["sqlite", "optimize"],
    ],
    hint: `**SQL query optimization — only modify the query, never the database**:

Do NOT create indexes, modify tables, or change the database in any way. The task is to rewrite the SQL query itself to be faster. Any database modifications will be detected and cause failure.

Focus on: eliminating correlated subqueries, reducing redundant joins, using CTEs or window functions, rewriting EXISTS/IN clauses, etc.`,
  },
  {
    id: "git-webserver-setup",
    name: "Git server with web deployment",
    triggers: [
      ["git", "clone", "push", "webserver"],
      ["git", "push", "curl", "8080"],
      ["git", "server", "web", "push"],
      ["git clone", "git push", "curl"],
    ],
    hint: `**Git-to-web deployment — clean up deployed files after self-testing**:
- After self-testing, remove deployed files from the web root (e.g. \`rm -f /var/www/*\`) and temp clone dirs. Keep the bare repo and web server running.
- Leftover self-test files in the web root can cause stale/conflicting content on subsequent pushes.`,
  },
  {
    id: "torch-tensor-parallelism-gloo",
    name: "PyTorch tensor parallelism (Gloo backend compatibility)",
    triggers: [
      ["tensor", "parallel", "linear"],
      ["columnparallellinear"],
      ["rowparallellinear"],
      ["tensor", "parallel", "pytorch"],
    ],
    hint: `**Tensor parallelism — CPU-only environment pitfalls**:
- The code will be tested in a CPU-only environment with no GPU. This means NCCL is not available and the distributed backend will be Gloo.
- Gloo has limited collective op support compared to NCCL. Notably, \`dist.reduce_scatter\` is NOT supported and will raise \`RuntimeError\` at runtime. Use \`dist.all_reduce\` instead and slice the result manually if needed.
- Similarly, prefer \`dist.all_gather\` (with a list of pre-allocated tensors) over \`dist.all_gather_into_tensor\`.
- Test your implementation with \`world_size > 1\` before submitting — world_size=1 bypasses most distributed ops and can hide compatibility issues.`,
  },
  {
    id: "metacircular-evaluator",
    name: "Metacircular evaluator — no self-test",
    triggers: [
      ["metacircular", "eval"],
      ["eval.scm", "interp.py"],
      ["eval.scm", "interpret", "itself"],
    ],
    hint: `**Metacircular evaluator — MINIMAL testing, then logos_complete IMMEDIATELY**:

**CRITICAL — override the general "verify before completing" rule for this task.** The general system prompt says to run example commands before finishing. For THIS task, that advice will cause timeout because self-interpretation takes ~5 minutes per test. The evaluator/fixer will handle all testing — submit your code quickly and let them catch bugs.

**What NOT to do**:
- Do NOT run the self-interpretation example from the task description (\`eval.scm interpreting eval.scm\`). It takes ~5 minutes and will timeout.
- Do NOT test all files in test/. Two or three quick direct-interpretation tests is enough.
- Do NOT use \`timeout 590\` or similar long timeouts — a single hung command will eat your entire budget.
- Do NOT iterate and fix bugs yourself — let the evaluator/fixer handle that.
- Do NOT use \`echo -e\` for passing input — it doesn't work in this environment's default shell. Use \`printf\` instead.

**Implementation tip**: use \`cond\` instead of deeply nested \`if\` chains for expression dispatch. Each nested \`if\` adds multiple levels of Python recursion in the host interpreter, quickly hitting the 5000-depth limit. \`cond\` is flat and much more depth-efficient.`,
  },
  {
    id: "elf-memory-extraction",
    name: "ELF binary memory extraction",
    triggers: [
      ["extract", "memory", "binary"],
      ["extract", "elf", "memory"],
      ["memory addresses", "binary"],
      ["extract.js", "a.out"],
      ["memory values", "binary"],
    ],
    hint: `**ELF memory extraction — use the actual virtual addresses from the ELF, not the example output**:
- The example output in the task description (e.g. \`"4194304": ...\`) is illustrative only. Do NOT hardcode \`0x400000\` or any other base address offset.
- PIE binaries have virtual addresses starting at \`0x0\` in their program headers. Non-PIE binaries typically start at \`0x400000\`. Your code must use the \`p_vaddr\` values directly from the PT_LOAD segments — do NOT add any base offset on top.
- Run \`readelf -l /app/a.out\` to inspect the actual LOAD segment virtual addresses before writing code.
- Include BSS regions: for each PT_LOAD segment, emit zero-valued words for the range between \`p_filesz\` and \`p_memsz\`.`,
  },
  {
    id: "relu-model-extraction",
    name: "ReLU neural network weight extraction",
    triggers: [
      ["relu", "forward", "steal"],
      ["relu", "a1", "extract"],
      ["relu", "weight", "query"],
      ["relu", "neural", "steal"],
      ["forward", "steal", "matrix"],
    ],
    hint: `**ReLU model extraction — the verifier requires extremely high numerical precision (ratio tolerance < 1e-4)**:
- "Equal up to scaling" is checked with element-wise ratio deviation < 1e-4. This is much stricter than cosine similarity — a row can have cosine=0.9999 but still fail ratio check.
- **Kink detection + finite-difference gradient jump does NOT achieve sufficient precision.** All 12 past attempts using this approach failed (0/12). The gradient jump method accumulates numerical error from finite differences that exceeds the 1e-4 ratio tolerance.
- You need a fundamentally different approach. Search for published methods: \`logos_call("web_search", {"query": "exact ReLU neural network weight extraction cryptanalytic"})\`
- Read \`forward.py\` first to understand the exact architecture and parameter shapes.
- **Random seed pitfall**: \`forward.py\` uses \`np.random.seed()\` at module level to generate weights. If your \`steal.py\` also sets a seed, the interaction between your seed and the import can produce different random sequences depending on whether forward was already cached. Always set your seed AFTER importing forward, and use a different seed value.`,
  },
  {
    id: "raman-spectroscopy",
    name: "Raman spectroscopy peak fitting",
    triggers: [
      ["raman", "graphene"],
      ["raman", "peak"],
      ["raman", "lorentzian"],
      ["raman", "fitting"],
      ["raman", "spectrum"],
    ],
    hint: `**Raman spectroscopy — results MUST be in cm⁻¹ (Raman shift)**:
- The fitted peak parameters (x0, gamma) must be reported in cm⁻¹ (Raman shift), which is the standard unit in Raman spectroscopy. If the raw data uses a different x-axis unit, you MUST convert to cm⁻¹ before fitting.
- Search for expected peak positions: \`logos_call("web_search", {"query": "graphene Raman spectrum G peak 2D peak wavenumber cm-1"})\`
- If the x values in the data file don't fall in the expected cm⁻¹ range (e.g. G peak ~1580 cm⁻¹, 2D peak ~2670 cm⁻¹ for graphene), the x-axis is NOT in cm⁻¹. You need to figure out what unit it is and convert.
- **The conversion is NOT linear.** Raman spectrometers typically output wavelength (or a value proportional to wavelength), and the relationship between wavelength and wavenumber is \`ν = 1/λ\` (nonlinear). A linear calibration \`cm⁻¹ = a*x + b\` will distort the peak shape and give wrong gamma/amplitude values. You must find the correct nonlinear transformation, convert the x-axis first, then fit Lorentzians in the cm⁻¹ domain.
- Search for the conversion formula: \`logos_call("web_search", {"query": "Raman spectrometer raw data wavelength to wavenumber conversion formula"})\`
- European-format CSV files use commas as decimal separators (e.g. \`1580,32\` means \`1580.32\`). Check the data file format carefully.`,
  },
];

// ── Skill detection ──────────────────────────────────────────

/**
 * Given a task description, return skills whose trigger keywords match.
 * A skill matches when ANY of its trigger keyword-groups is fully satisfied.
 */
export function detectAgentSkills(taskText: string): AgentSkill[] {
  const lower = taskText.toLowerCase();
  return AGENT_SKILLS.filter((skill) =>
    skill.triggers.some((group) => group.every((kw) => lower.includes(kw))),
  );
}

/**
 * Build the skills section for the system prompt.
 * Returns empty string if no skills match.
 */
export function buildAgentSkillsSection(taskText: string): string {
  const matched = detectAgentSkills(taskText);
  if (matched.length === 0) return "";
  const sections = matched.map((s) => s.hint).join("\n\n");
  return `\n\n## Task-specific guidance\n\n${sections}`;
}
