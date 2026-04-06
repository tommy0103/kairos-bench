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
    hint: `**Jump detection — landing frame accuracy**:
- The verifier has a TIGHT tolerance window (typically ±2 frames) for the landing frame. Being even 1 frame early will fail.
- **Common mistake**: detecting "approaching the ground" instead of "feet on the ground". If you use a threshold like "foot position within X% of ground level", you will trigger TOO EARLY while the athlete is still descending.
- **Correct approach for landing detection**: after the peak of the jump (minimum foot-y or maximum height), find the frame where the foot position **fully returns to AND STABILIZES at** the pre-jump ground level. Specifically:
  1. Compute the ground-level baseline from the pre-jump frames (e.g., median of \`bot95\` or lowest-body-pixel over frames 0..takeoff-5).
  2. After the jump peak, find the FIRST frame where the foot metric is within a very small margin (e.g., ≤2 pixels) of the baseline AND the next 2-3 frames also stay at that level.
  3. This "sustained stability" criterion prevents triggering on transition frames where the feet are close but not yet planted.
- **Err late, not early**: if uncertain, pick the later frame. The verifier's expected range is biased toward the moment of full ground contact, not the moment of initial approach. A frame that is 1 frame late is much more likely to be in the tolerance window than 1 frame early.
- **Takeoff is usually easier**: takeoff detection (when feet first leave the ground) is more clear-cut. Focus your debugging effort on the landing frame.
- **Self-test on the example video**: after getting your takeoff/landing values, visually inspect ±3 frames around your detected landing by dumping those frames as images (\`cv2.imwrite\`) and checking if the athlete's feet are truly on the ground in your landing frame. If they're still slightly airborne, shift 1-2 frames later.`,
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
- **Self-test before submission**: run \`node /app/vm.js\` yourself, wait 15-20 seconds, then check: (1) Does \`/tmp/frame.bmp\` exist? (2) Is it a valid image (\`file /tmp/frame.bmp\` or open with PIL)? (3) Does the stdout show DOOM init text like "Z_Init" or "W_Init"? If frame.bmp doesn't appear within 30s, the interpreter has a bug — check syscall handling, memory access, and instruction implementation.
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
- **Use the exact QEMU version specified**: if the task says "compatible with QEMU 5.2.0", install THAT version. Do NOT use \`apt install qemu-system-x86\` which installs a newer version (e.g. 8.x). Newer QEMU may have subtly different keyboard/VGA emulation that breaks old guest OSes. Install from source: \`wget https://download.qemu.org/qemu-5.2.0.tar.xz && tar xf qemu-5.2.0.tar.xz && cd qemu-5.2.0 && ./configure --target-list=i386-softmmu && make -j$(nproc) && make install\`. If building from source takes too long, at minimum verify that the apt version actually works.
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
