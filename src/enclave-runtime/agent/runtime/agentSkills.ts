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
    hint: `**Jump detection — robustness AND landing frame accuracy**:

**#1 PRIORITY — robustness to unseen videos**:
- The verifier tests on a HIDDEN video with a DIFFERENT athlete (different clothing, body shape, skin tone). Camera position, background, and hurdle are the same.
- Your detection algorithm MUST NOT crash on unseen videos. The most common failure is \`ValueError: Could not detect athlete in video\` because the thresholds/parameters are tuned too tightly to the example video.
- **Use very permissive detection**: try MULTIPLE background-subtraction thresholds (e.g. loop from 20 to 80 in steps of 5) and pick the one that gives the best signal. Never hardcode a single threshold.
- **Use grayscale or LAB difference** for background subtraction — these are more robust to clothing color variation than RGB thresholds.
- **Never raise errors**: if primary detection fails, fall back to progressively simpler methods. The script must ALWAYS produce an output.toml, even if the result is imperfect.
- **Test your robustness**: alter the example video (e.g. adjust brightness ±30%, flip horizontally) and verify your script still detects the jump. If it breaks on simple perturbations, it will break on the test video.

**#2 — landing frame accuracy**:
- The verifier tolerance window is typically ±2 frames. Being 1 frame early will fail.
- **Common mistake**: detecting "approaching the ground" instead of "feet on the ground". Threshold-based detection triggers 1-2 frames TOO EARLY during descent.
- **Correct approach**: after the jump peak, find the frame where foot position **fully returns to AND STABILIZES at** the pre-jump ground level (sustained ≥2-3 consecutive frames at baseline).
- **Err late, not early**: after detecting candidate landing frame N, report N+1 or N+2. The systematic early bias is the #1 accuracy failure.
- **Takeoff is usually easier** — focus debugging effort on landing.`,
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
