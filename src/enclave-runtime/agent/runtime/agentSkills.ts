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
