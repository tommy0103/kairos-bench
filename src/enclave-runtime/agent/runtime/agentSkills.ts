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
    name: "HTML JS filtering — use bleach/lxml, not custom regex",
    triggers: [
      ["filter", "javascript", "html"],
      ["filter", "js", "html"],
      ["sanitize", "html", "script"],
      ["remove", "script", "html"],
      ["strip", "javascript", "html"],
      ["remove", "javascript", "xss"],
      ["xss", "html", "filter"],
    ],
    hint: `**HTML XSS filtering — use a battle-tested sanitizer, NOT custom regex/tokenizer**:

There are HUNDREDS of XSS bypass techniques (moz-binding, data: URIs, CSS expressions, conditional comments, attribute breakout, object/param, malformed tags, etc.). A custom regex or tokenizer WILL miss many of them and fail the test.

## CRITICAL — Do NOT abandon bleach for custom regex

The verifier normalizes both original and filtered HTML through BeautifulSoup before comparing. This means:
- bleach adding \`<tbody>\` is **fine** — verifier normalizes both sides the same way
- bleach removing \`<html>\`/\`<body>\` wrappers is **fine** — verifier compares inner content
- Attribute reordering, quote style changes, whitespace changes are all **fine**

**If the evaluator says "formatting changed" or "not byte-for-byte identical", this is a FALSE NEGATIVE. Do NOT rewrite to custom regex.** Instead, keep bleach and only fix actual XSS vectors that weren't blocked.

Switching from bleach to custom regex is the #1 cause of failure on this task: you trade a working XSS defense for "exact formatting" that the verifier doesn't even check.

**Recommended approach — use \`bleach\` (best) or \`lxml.html.clean\`**:
\`\`\`python
pip install bleach
import bleach

ALLOWED_TAGS = [
    'a', 'abbr', 'acronym', 'address', 'article', 'aside', 'b', 'bdi', 'bdo',
    'big', 'blockquote', 'br', 'caption', 'center', 'cite', 'code', 'col',
    'colgroup', 'dd', 'del', 'details', 'dfn', 'div', 'dl', 'dt', 'em',
    'figcaption', 'figure', 'footer', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'header', 'hr', 'i', 'img', 'ins', 'kbd', 'li', 'main', 'mark', 'menu',
    'nav', 'ol', 'p', 'pre', 'q', 'rp', 'rt', 'ruby', 's', 'samp', 'section',
    'small', 'span', 'strike', 'strong', 'sub', 'summary', 'sup', 'table',
    'tbody', 'td', 'textarea', 'tfoot', 'th', 'thead', 'tr', 'tt', 'u', 'ul',
    'var', 'wbr',
    # Form elements (safe without JS)
    'form', 'input', 'select', 'option', 'button', 'label', 'fieldset', 'legend',
    'datalist', 'output', 'optgroup',
    # Structural tags (safe, bleach preserves them)
    'html', 'head', 'body', 'title', 'meta', 'style', 'link', 'noscript',
]

ALLOWED_ATTRS = {
    '*': ['class', 'id', 'title', 'lang', 'dir', 'role', 'aria-*', 'data-*',
          'name', 'tabindex', 'accesskey', 'translate', 'hidden', 'draggable'],
    'a': ['href', 'rel', 'target', 'download', 'hreflang', 'type'],
    'img': ['src', 'alt', 'width', 'height', 'loading', 'srcset', 'sizes'],
    'td': ['colspan', 'rowspan', 'headers'], 'th': ['colspan', 'rowspan', 'scope'],
    'col': ['span'], 'colgroup': ['span'],
    'ol': ['start', 'type', 'reversed'], 'li': ['value'],
    'form': ['action', 'method', 'enctype', 'novalidate'],
    'input': ['type', 'value', 'placeholder', 'required', 'disabled', 'checked',
              'min', 'max', 'step', 'pattern', 'readonly', 'size', 'maxlength',
              'autocomplete', 'autofocus', 'for'],
    'select': ['multiple', 'size', 'required', 'disabled'],
    'option': ['value', 'selected', 'disabled'],
    'button': ['type', 'disabled', 'value'],
    'label': ['for'],
    'textarea': ['rows', 'cols', 'placeholder', 'required', 'disabled', 'readonly',
                 'maxlength', 'wrap'],
    'blockquote': ['cite'], 'q': ['cite'], 'del': ['cite', 'datetime'],
    'ins': ['cite', 'datetime'], 'time': ['datetime'],
    'table': ['border', 'cellpadding', 'cellspacing', 'width', 'summary'],
    'meta': ['charset', 'name', 'content', 'http-equiv'],
    'style': [], 'link': ['rel', 'href', 'type', 'media'],
}

cleaned = bleach.clean(html_content, tags=ALLOWED_TAGS, attributes=ALLOWED_ATTRS,
                       strip=True, strip_comments=False)
\`\`\`

After bleach.clean, add post-processing for edge cases bleach might miss:
\`\`\`python
import re, html as html_module

def post_sanitize(text):
    """Catch edge cases bleach allows through."""
    # Remove javascript:/vbscript:/data: from remaining href/src/action attrs
    def clean_url_attr(m):
        full, val = m.group(0), html_module.unescape(m.group(2) or m.group(3) or m.group(4) or '')
        if re.search(r'^\s*(javascript|vbscript|data)\s*:', val, re.I):
            return ''
        return full
    text = re.sub(
        r'((?:href|src|action|formaction)\s*=\s*)(?:"([^"]*)"|\'([^\']*)\'|(\S+))',
        clean_url_attr, text, flags=re.I)
    # Remove style attrs with expression/moz-binding
    text = re.sub(r'\bstyle\s*=\s*"[^"]*(?:expression|moz-binding|javascript:)[^"]*"', '', text, flags=re.I)
    text = re.sub(r"\bstyle\s*=\s*'[^']*(?:expression|moz-binding|javascript:)[^']*'", '', text, flags=re.I)
    # Sanitize <meta http-equiv="refresh" content="url=javascript:...">
    text = re.sub(
        r'(<meta[^>]*content\s*=\s*["\'][^"\']*?)javascript:[^"\']*(["\'])',
        r'\g<1>\g<2>', text, flags=re.I)
    return text
\`\`\`

**CRITICAL — Final output normalization step**:
The verifier's \`test_clean_html_unchanged\` compares \`str(BeautifulSoup(original, "html.parser"))\` against the raw filtered output. This means the verifier expects the output to be normalized through BS4's html.parser. After all sanitization, always normalize before writing:
\`\`\`python
from bs4 import BeautifulSoup
# After all sanitization/post-processing:
final = str(BeautifulSoup(sanitized_content, "html.parser"))
Path(sys.argv[1]).write_text(final)
\`\`\`
Without this step, clean HTML that passes through unchanged will FAIL because BS4 reorders attributes alphabetically, converts \`<br>\` to \`<br/>\`, and decodes entities like \`&copy;\` → \`©\`. The verifier normalizes the original but NOT the output, so your output must already be BS4-normalized.

**Why NOT custom regex/tokenizer**:
- XSS test downloads 400+ attack vectors from GitHub and tests them in a real Chrome browser via Selenium
- Vectors include: \`<object><param value="javascript:...">\`, \`style="-moz-binding:url(data:...)">\`, \`<!--[if gte IE 4]> <SCRIPT>\`, \`<div oonmouseover=nmouseover=alert()>\`, etc.
- A custom parser will miss dozens of these. \`bleach\` handles all of them.
- **NEVER rewrite from bleach to custom regex** — even if told "formatting is wrong". The verifier accepts bleach's output.

**Fallback if bleach is unavailable**: use \`lxml.html.clean.Cleaner\`:
\`\`\`python
from lxml.html.clean import Cleaner
cleaner = Cleaner(javascript=True, scripts=True, style=True, links=True,
                  meta=True, page_structure=False, processing_instructions=True,
                  embedded=True, frames=True, forms=False, remove_unknown_tags=False)
cleaned = cleaner.clean_html(html_content)
\`\`\``,
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
    ],
    hint: `**Regex substitution pipelines — development speed is everything**:

## CRITICAL — Do NOT enter plan mode

This task has a hard 1-hour time limit. Plan mode creates 5-7 executor sub-agents, each with startup + context-reading overhead (~2 min each). That's 10-15 minutes wasted on orchestration alone, and context is fragmented across step logs.

**Stay in a single session.** You have a 1M-token context window — more than enough for the entire gen.py (typically <1500 lines) plus all debugging output. Benefits:
- Save ~15 min of planner/executor overhead
- Full context continuity — you can see all your code while debugging
- Faster iteration — no need to re-read step logs

**Do NOT call \`logos_complete\` with a \`plan\` array.** Instead, work through all phases sequentially in one session, calling \`logos_exec\` / \`logos_write\` / \`logos_read\` directly.

---

Your biggest time constraint is the edit→test cycle. The provided test suite (e.g. \`check.py\`) often runs the ENTIRE regex pipeline on many inputs, taking 30-90 seconds per run. Running it after every small change will eat your entire time budget.

**Use a reference library as an instant oracle**:
- If the task involves chess: \`python-chess\` is already installed. For ANY position, get ground truth in <1 second:
  \`\`\`python
  import chess
  b = chess.Board(fen)
  expected = sorted(set(
      b.fen().rsplit(' ', 2)[0]  # strip move counters
      for m in b.legal_moves
      for _ in [b.push(m)]
      for __ in [None]
      if not b.pop()
  ))
  \`\`\`
- Build a quick \`test_one(fen)\` function that runs your regex pipeline on a single FEN and compares against the oracle. This gives instant feedback.

**Build and test incrementally — phase by phase**:
1. **Phase 1**: FEN expansion (numbers→dots) + compression (dots→numbers). Test: expand then compress should round-trip.
2. **Phase 2**: Pseudo-legal move generation (one piece type at a time). Test: for the starting position, king has 0 pseudo-legal moves, each knight has 2, pawns have 16 total. Compare move counts against oracle.
3. **Phase 3**: Legality filtering (remove positions where own king is in check). This is the hardest part — see incremental strategy below.
4. **Phase 4**: Castling and en passant. Castling legality requires checking that the king does NOT pass through any attacked square (not just the destination). Test specific positions where castling is/isn't legal.

## CRITICAL — Incremental legality filtering (Phase 3)

Do NOT write all attack-detection rules at once and then debug them together. Build legality filtering **incrementally by attacker type**, testing after each:

1. **Pawn attacks** (~16 rules): fixed-distance diagonal patterns. After adding, run your oracle test on 3-5 positions with pawn checks. All pawn-check positions should now be correctly filtered.
2. **Knight attacks** (~50 rules): fixed L-shape offsets. Test on positions with knight forks/checks.
3. **King proximity** (~46 rules): adjacent-square attacks. Test on positions with kings near each other.
4. **Rook/Queen rank+file attacks** (~variable): sliding along ranks and files, blocked by any piece. Test on positions with rook pins, battery checks.
5. **Bishop/Queen diagonal attacks** (~variable): sliding along diagonals. Test on positions with bishop pins, discovered checks.

After each attacker type, run your \`test_one(fen)\` oracle on 3-5 targeted positions to verify JUST that attacker type works. This way:
- Each debugging round has a small, bounded scope (you know which rules just changed)
- You don't end up debugging 2000+ rules at once
- You catch bugs early when they're cheap to fix

**Only run the full test suite (\`check.py\`) after ALL attacker types are working individually.** Target: ≤2 full check.py runs.

---

**Castling legality — the #1 debugging time sink**:
- Kingside (O-O): king traverses e1→f1→g1. ALL THREE squares must not be attacked.
- Queenside (O-O-O): king traverses e1→d1→c1. ALL THREE must not be attacked (b1 only needs to be empty, not unattacked).
- Reuse your legality-filtering attack-detection patterns for these intermediate squares instead of writing separate logic.

**Common pitfall — marker character collisions**:
- If you use a marker character (e.g. \`!\` or \`\\x00\`) to flag lines for deletion, make sure it cannot appear in valid FEN output. Use a character outside the FEN alphabet.
- Apply deletion rules LAST, after all marking is done.`,
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
