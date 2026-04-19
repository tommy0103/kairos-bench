# Failure Analysis — 2026-04-19\_\_17-00-00

## Trial Count Discrepancy

89 tasks × 5 trials = 445 expected. 441 scored, 4 unscored:

| Trial                               | Reason                                                           |
| ----------------------------------- | ---------------------------------------------------------------- |
| `extract-moves-from-video__bHGSWJs` | AgentTimeoutError — no verifier result                           |
| `query-optimize__CYcBiZe`           | NonZeroAgentExitCodeError — bench-runner crashed before verifier |
| `query-optimize__pcaJ6Cf`           | VerifierTimeoutError — verifier timed out                        |
| `regex-chess__PxdLDPm`              | NonZeroAgentExitCodeError — bench-runner crashed before verifier |

These 4 trials crashed hard enough that the verifier never ran (or timed out), so no reward was recorded.

## NonZeroAgentExitCodeError (160/445 = 36%)

This is the **dominant error**. The bench-runner process (`bun run bench-runner.ts`) exits with code 1 due to uncaught exceptions in `main().catch()`.

### Root Cause Breakdown

| Cause                                             | Count | Impact                                                                                                                                |
| ------------------------------------------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `500 Internal Server Error` (LLM API)             | 151   | Evaluator API call fails, bench-runner crashes. Verifier usually still runs (agent output already written).                           |
| `400 No tool call found for function call output` | 4     | OpenAI API rejects tool response — possible race condition or message format issue.                                                   |
| Git errors (in agent output, not bench-runner)    | ~14   | `fatal: not a git repository` etc. — these are from agent's `logos_exec` output containing "fatal:", not actual bench-runner crashes. |

**Key finding**: 151/160 NZEC are caused by **evaluator API 500 errors**. The bench-runner has no retry logic for evaluator API calls — a single 500 kills the evaluator/fixer cycle. Despite this, most trials still pass because the agent already wrote correct output before the evaluator ran.

### Recommendation

- Add retry logic (3 attempts with exponential backoff) for API calls in the evaluator
- The 500 errors are wasting evaluator/fixer cycles that could have caught remaining bugs

## AgentTimeoutError (39/445 = 9%)

Agent exceeded the 900s time limit. Breakdown by task:

| Task                     | Timeouts  | Notes                            |
| ------------------------ | --------- | -------------------------------- |
| caffe-cifar-10           | 5/5       | Training on CPU always times out |
| extract-moves-from-video | 4/4       | Video analysis too slow          |
| make-doom-for-mips       | 4/5       | Cross-compilation + debugging    |
| path-tracing             | 3/5       | Rendering takes too long         |
| rstan-to-pystan          | 3/5       | MCMC sampling slow               |
| chess-best-move          | 3/5       | FEN recognition + engine         |
| compile-compcert         | 2/5       | Coq proof compilation            |
| gpt2-codegolf            | 3/5       | Iterating on C implementation    |
| Others                   | scattered | 1-2 each                         |

## VerifierTimeoutError (1/445)

Only `query-optimize__pcaJ6Cf` — the verifier likely ran the unoptimized query which timed out.

## Consistently Failing Tasks (0% across 5 trials)

| Task                         | Failures | Root Cause                                                            | Fix Status                                             |
| ---------------------------- | -------- | --------------------------------------------------------------------- | ------------------------------------------------------ |
| caffe-cifar-10               | 0/5      | CPU training always times out; `test_interval` wastes time on testing | Skill exists but insufficient — timeout is fundamental |
| dna-insert                   | 0/5      | Q5 SDM primer design + boundary ambiguity                             | Skill added, needs verification                        |
| extract-moves-from-video     | 0/4      | Video frame analysis fundamentally hard, always times out             | No skill — may need different approach                 |
| model-extraction-relu-logits | 0/5      | Gradient methods can't achieve 1e-4 ratio precision                   | Skill added warning against gradient methods           |
| sam-cell-seg                 | 0/5      | MobileSAM polyline conversion issues                                  | Skill exists but may need update                       |
| make-doom-for-mips           | 0/5      | Cross-compilation complexity + reading VM source + timeouts           | Skill exists                                           |

## Major Regressions (100% → ≤20%)

| Task                 | Master | Latest | Likely Cause                                        |
| -------------------- | ------ | ------ | --------------------------------------------------- |
| gcode-to-text        | 1/1    | 1/5    | Needs investigation — OCR + semantic disambiguation |
| headless-terminal    | 1/1    | 1/5    | Needs investigation                                 |
| install-windows-3-11 | 1/1    | 1/5    | QEMU Windows boot is fragile                        |

Note: Master had only 1 trial per task, so "100%" may be lucky. These tasks may have always been ~20-40% reliable.

## Summary

- **Overall**: 80.7% (356/441) — solid but 36% of trials have NZEC (mostly harmless API 500s)
- **The #1 infrastructure fix needed**: retry logic for evaluator API calls (would eliminate 151 NZEC errors and potentially improve scores by giving evaluator/fixer a chance to catch bugs)
- **The #1 task-level fix needed**: the 6 persistently-0% tasks need fundamentally different approaches, not just skill hints
