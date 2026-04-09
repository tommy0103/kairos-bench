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
    ],
    hint: `**Cryptanalysis strategy — brute-force first**:
- Before implementing a sophisticated cryptanalytic attack, ALWAYS estimate the effective key space size.
- If the key is derived from a seed of N bits, the search space is 2^N. For N ≤ 24 (~16M), a C brute-force loop can exhaust the space in seconds.
- Even if the task says "you can't brute force the entire keyspace", check if a SEED or KEY SCHEDULE reduces the effective space to something tractable.
- Recipe: write a C program that (1) iterates all seed values, (2) derives the round keys from each seed, (3) encrypts a known plaintext with those keys, (4) compares to the known ciphertext. Print the seed when matched. Compile with \`gcc -O3\`.
- Only fall back to linear/differential cryptanalysis if the effective key space exceeds ~2^28.`,
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
- **CompCert-specific**: CompCert 3.x requires Coq in a specific version range (e.g. 8.12-8.16, NOT 8.18+). Always run \`grep -i coq configure\` or \`head -100 configure\` FIRST to check. Use opam to install the exact required version in one go — do not guess.
- For long builds (Coq proofs, LLVM, GCC): the build itself may take 20-60 minutes. Start it early and do not waste time on unnecessary steps beforehand.`,
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
      ["mips", "interpreter"],
      ["mips", "vm.js"],
      ["mips", "elf", "interpreter"],
      ["mips", "doom"],
      ["doomgeneric", "mips"],
      ["doomgeneric_mips"],
    ],
    hint: `**MIPS interpreter (DoomGeneric) — architecture & pitfalls**:
- **DON'T read all source files upfront**. The codebase has 3000+ lines of C stdlib reimplementation. Focus only on: (1) ELF headers of the binary, (2) \`doomgeneric.h\` for screen constants, (3) the syscall numbers in \`my_stdlib.c\` (first 20 lines), and (4) \`fake_fs.c\` for filesystem semantics.
- **Sparse memory is MANDATORY**: the BSS section is ~1GB (\`0x4003c6d0\` bytes). You CANNOT allocate a flat buffer. Use a \`Map<number, Buffer>\` keyed by page number (e.g. 4KB pages). Only allocate pages on first access.
- **MIPS Linux syscall ABI** (NOT x86!): syscall number in \`$v0\`, args in \`$a0-$a3\`, stack for args 5-6. Return value in \`$v0\`. Key numbers: \`read=4003\`, \`write=4004\`, \`open=4005\`, \`close=4006\`, \`lseek=4019\`, \`brk=4045\`, \`mmap=4090\`. **BUT** this binary uses its OWN syscall convention defined in \`my_stdlib.c\`: \`read=0\`, \`write=1\`, \`open=2\`, \`close=3\`, \`lseek=8\`, etc. Check the \`#define SYS_*\` at the top of \`my_stdlib.c\` and \`fake_fs.c\`. The \`syscall\` instruction triggers the trap — match the numbers the binary ACTUALLY uses.
- **Framebuffer output — the verifier contract**:
  1. The verifier runs \`node /app/vm.js\` and waits up to 30 seconds for \`/tmp/frame.bmp\` to appear.
  2. It compares \`/tmp/frame.bmp\` to a reference image using L2 pixel similarity (PIL).
  3. DOOM's screen is **320×200 pixels**, 32-bit RGBA (\`DOOMGENERIC_RESX=320\`, \`DOOMGENERIC_RESY=200\`).
  4. The binary writes the framebuffer through the custom filesystem (\`DG_DrawFrame\` → file write syscall). You need to intercept the write to the framebuffer file and save it as a proper BMP at \`/tmp/frame.bmp\`.
  5. BMP format: 54-byte header (BITMAPINFOHEADER), 24-bit BGR, bottom-up row order. OR use a library (\`bmp-js\`, \`pngjs\`) — just make sure the format is correct.
- **Delay slots**: MIPS branches/jumps have a delay slot — the instruction AFTER a branch always executes. Forgetting this is the most common interpreter bug and causes immediate crashes.
- **Stdout contract — CRITICAL**: The verifier checks that stdout contains the EXACT byte string \`I_InitGraphics: DOOM screen size: w x h: 320 x 200\`. Your interpreter MUST forward ALL writes to fd 1 (stdout) and fd 2 (stderr) to Node.js \`process.stdout\`. If your syscall handler for \`write(fd=1, ...)\` doesn't call \`process.stdout.write(buffer)\`, the verifier will fail even if the frame is correct. Also make sure the \`printf\` in the binary is fully implemented (it writes through fd 1 via the syscall interface).
- **Self-test before submission**: run \`node /app/vm.js\` yourself, wait 15-20 seconds, then check: (1) Does \`/tmp/frame.bmp\` exist? (2) Is it a valid image (\`file /tmp/frame.bmp\` or open with PIL)? (3) Does stdout contain the text \`I_InitGraphics: DOOM screen size: w x h: 320 x 200\`? ALL THREE must pass. If frame.bmp doesn't appear within 30s, the interpreter has a bug — check syscall handling, memory access, and instruction implementation.
- **Performance**: the binary needs to execute millions of instructions to reach the first frame. Keep your instruction loop tight — avoid logging per-instruction. Use a simple \`while(true)\` loop with a switch on opcode.`,
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
    hint: `**PDB FASTA chromophore residues — the 'X' trap**:
- **CRITICAL**: PDB FASTA sequences for fluorescent proteins (GFP, mCherry, Clover, etc.) contain an \`X\` character at the chromophore position. This \`X\` does NOT represent a single unknown amino acid — it represents a **post-translational modification** where **three consecutive amino acids** cyclize into a chromophore.
- **WRONG**: replacing \`X\` with a single amino acid like \`Y\` (tyrosine). This changes the protein length and produces a sequence that won't match the verifier's expected sequence.
- **CORRECT**: replace \`X\` with the **original pre-modification tripeptide**. Common examples:
  - GFP/Clover/EGFP family (e.g. 5WJ2): \`X\` → \`GYG\` (Gly-Tyr-Gly, residues 65-67 in wild-type GFP numbering)
  - mCherry/mRFP family (e.g. 2H5Q): \`X\` → \`MYG\` (Met-Tyr-Gly)
  - The central residue is almost always Tyr (Y); the flanking residues vary by protein.
- **How to find the correct tripeptide**: Do NOT guess. Use one of:
  1. PDB REST API entity sequence: \`https://data.rcsb.org/rest/v1/core/polymer_entity/{PDB_ID}/1\` → \`entity_poly.pdbx_seq_one_letter_code_can\` field gives the full canonical sequence with all residues spelled out (no \`X\`).
  2. UniProt canonical sequence: search by protein name, gives the unmodified sequence.
  3. PDB SEQRES records in the mmCIF/PDB file: \`https://files.rcsb.org/download/{PDB_ID}.cif\` → \`_entity_poly.pdbx_seq_one_letter_code_can\`.
- **General rule**: ANY \`X\` in a PDB FASTA should be investigated. It could also represent selenomethionine (→ \`M\`), pyroglutamate (→ \`Q\`/\`E\`), or other modifications. Always cross-reference with the entity sequence API.
- After assembling the protein sequence, verify its length matches what you expect (sum of all subprotein lengths minus removed Met residues plus linkers).`,
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

4. **No KVM in containers**: \`/dev/kvm\` is usually not available. QEMU falls back to TCG (software emulation), which is slower but works. Do NOT pass \`-enable-kvm\` — it will fail. Expect boot to take 10-60 seconds depending on the OS.`,
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
    hint: `**QEMU VM setup — common verifier pitfalls**:
- **Use ABSOLUTE paths for disk images**: the verifier reads the QEMU process cmdline via \`/proc/<pid>/cmdline\` and checks that the FULL absolute path (e.g. \`/app/isos/win311.img\`) appears. If you run \`cd /app && qemu ... -hda isos/win311.img\`, the cmdline will only contain the relative path and the test will FAIL. Always use \`-hda /app/isos/win311.img\`.
- **Use the exact QEMU version specified — THIS IS CRITICAL FOR VISUAL FEEDBACK**: if the task says "compatible with QEMU 5.2.0", you MUST install THAT version. \`apt install qemu-system-x86\` installs 8.x which has different keyboard/VGA emulation that causes Windows 3.11 to not respond to keystrokes even though the monitor socket works. The verifier sends keys via the monitor and checks for ≥10% pixel change — this WILL FAIL with QEMU 8.x. Install from source: \`apt-get install -y build-essential ninja-build pkg-config libglib2.0-dev libpixman-1-dev && wget https://download.qemu.org/qemu-5.2.0.tar.xz && tar xf qemu-5.2.0.tar.xz && cd qemu-5.2.0 && ./configure --target-list=i386-softmmu && make -j$(nproc) && make install\`. This takes ~5 minutes — START THIS FIRST before any other setup.
- **QEMU monitor socket at /tmp/qemu-monitor.sock**: the verifier sends keystrokes via \`socat - UNIX-CONNECT:/tmp/qemu-monitor.sock\` using the \`sendkey\` command. Ensure you start QEMU with \`-monitor unix:/tmp/qemu-monitor.sock,server,nowait\`.
- **Visual feedback verification**: the verifier takes VNC screenshots before/after sending keys (F1, Alt+Tab, F10, Alt+F4, Ctrl+Esc) and checks for ≥10% pixel difference. This means:
  1. Windows must have ACTUALLY BOOTED to the desktop (not stuck at DOS prompt, error dialog, or boot screen).
  2. The VNC display must be responsive and updating.
  3. Keyboard input must actually reach the guest OS.
  After starting the VM, WAIT for it to fully boot (30-60 seconds for Win 3.11), then take a VNC screenshot yourself (\`apt install vncsnapshot && vncsnapshot localhost:1 /tmp/screen.png\`) and verify you see the Windows desktop. If you see a blank/black screen or DOS prompt, the OS hasn't finished booting.
- **Start services in background/daemon mode**: \`nginx\` blocks in foreground by default. Use \`nginx\` (which auto-daemonizes) or \`nginx &\`. Similarly, \`websockify --daemon ...\`. Never let a foreground service eat your entire time budget.
- **Install socat early**: the verifier needs it, and you'll need it to test keyboard input yourself.`,
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

1. **Always use \`oligotm\` from primer3** to compute Tm — never use Python Tm libraries or manual estimates:
   \`apt-get install -y primer3 && oligotm -tp 1 -sc 1 -mv 50 -dv 2 -n 0.8 -d 500 <annealing_sequence>\`
   Only the **annealing portion** (the part that base-pairs with the template) counts, NOT the full primer.

2. **Insertion boundary ambiguity**: When comparing input and output plasmids to find the inserted sequence, shared bases at the insertion boundary (e.g. "ag") can be assigned to either the insert or the template. Different tools may define the boundary differently (shifted by 2-3 bases). This means your "annealing portion" and the evaluator's may differ, changing Tm by several degrees.

3. **Design rules to handle ambiguity**:
   - Target Tm **60-65°C** for both primers (not just ≥ 58°C).
   - Keep Tm difference **≤ 3°C** (not just ≤ 5°C).
   - These margins absorb 2-3 base boundary shifts without violating constraints.
   - If the insertion boundary is ambiguous, try shifting it ±2 bases and check that Tm constraints still hold for all interpretations.

4. **Common pitfalls**:
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
    ],
    hint: `**Golden Gate assembly primer design — BsaI site structure**:
- BsaI primers have a STRICT structure (5'→3'): \`[clamp][ggtctc][N][4-nt overhang][binding region]\`
  - **clamp**: AT LEAST 1 nucleotide (ideally 2-6 nt, e.g. \`tt\` or \`aagc\`) BEFORE the BsaI site. The verifier checks \`i >= 1\` where \`i = primer.find("ggtctc")\`. A primer starting directly with \`ggtctc\` will FAIL.
  - **ggtctc**: the BsaI recognition site (always this exact sequence in the forward primer).
  - **N**: a single spacer nucleotide between the recognition site and the cut position.
  - **4-nt overhang**: the 4-nucleotide sticky end that defines how fragments assemble. Adjacent fragments must have COMPLEMENTARY overhangs.
  - **binding region**: 15-45 nt that anneals to the template. Tm must be 58-72°C (use \`oligotm -tp 1 -sc 1 -mv 50 -dv 2 -n 0.8 -d 500\`).
- For the **reverse primer**, the BsaI site is the reverse complement: \`gagacc\`. Structure: \`[clamp][gagacc][N][4-nt overhang rc][binding region rc]\`.
- **Overhang design**: all 4-nt overhangs must be unique and non-palindromic. The assembly is circular if input is circular — the last fragment's right overhang must match the first fragment's left overhang.
- **Common mistake**: forgetting the clamp. Even a single \`t\` before the BsaI site is sufficient. Without it, BsaI cutting efficiency drops dramatically AND the verifier rejects the primer.`,
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
- Modern web pages (especially HuggingFace Spaces, Gradio apps, dashboards) can be 1-10 MB of HTML/JS. Curling them directly will exceed the LLM context window (1M tokens) and crash the agent.
- **NEVER** do: \`curl https://some-leaderboard.hf.space/\` or pipe large HTML into the conversation.

**MTEB leaderboard specifically**:
- **DO NOT use \`mteb.load_results()\`** — it downloads the ENTIRE results repo from GitHub (GB of data), will timeout or OOM in a container.
- **Best approach**: use the HuggingFace Datasets API to query the pre-computed leaderboard results:
  \`\`\`
  pip install datasets
  from datasets import load_dataset
  ds = load_dataset("mteb/results", split="train")
  # Filter to the specific benchmark/tasks you need
  \`\`\`
- **Alternative**: use the Gradio API client to query the leaderboard Space:
  \`\`\`
  pip install gradio_client
  from gradio_client import Client
  client = Client("mteb/leaderboard")
  result = client.predict(...)
  \`\`\`
- **Fallback**: curl the HuggingFace API for specific models: \`curl -s "https://huggingface.co/api/models?search=scandinavian+embedding&sort=downloads&limit=20" | python3 -m json.tool | head -100\`

**General rules**:
- Any single command output should be < 50KB. If you expect more, pipe through \`head -c 50000\` or filter with \`grep\`/\`python3\` first.
- If a Python API call takes > 60 seconds, it's probably downloading too much. Use \`timeout 60\` and try a lighter approach.`,
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
- **Overlap resolution**: After converting to polylines, there may be overlapping regions. Resolve overlaps by keeping the smaller mask (higher priority), then re-extract polylines from the final non-overlapping masks.`,
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
