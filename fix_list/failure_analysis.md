# Failure Analysis — 24 Failing Tasks

Source: `jobs/2026-04-13__11-00-00` baseline run

## TIMEOUT (14 tasks)

| Task                         | Root Cause                                                                          | Fixable with skill?                                                                                 |
| ---------------------------- | ----------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| adaptive-rejection-sampler   | Agent ran out of time; verifier R code crashes with coercion error in ARS           | Maybe — need to check if R implementation has a known pitfall                                       |
| caffe-cifar-10               | Build too slow — Caffe source compilation doesn't finish within timeout             | Partially — skill added to use apt package instead of source build, but 900s may still be too tight |
| compile-compcert             | Still installing opam/Coq dependencies at 2400s timeout; ccomp never built          | Skill exists but Coq version matching is critical — agent may need specific version hints           |
| extract-moves-from-video     | Tesseract OCR on large PNG frames hung (590s per call), agent never produced output | Maybe — need smarter frame extraction strategy, skip OCR on huge images                             |
| gpt2-codegolf                | C implementation produces wrong output — incorrect weight loading order             | Unlikely — code logic bug, not a skill issue                                                        |
| install-windows-3-11         | QEMU/Windows boots but VNC frozen, keyboard events produce no visual change         | Skill exists (qemu-vm-setup) but QEMU 5.2.0 source build may timeout                                |
| make-doom-for-mips           | MIPS cross-compilation failed, doomgeneric_mips ELF never produced                  | Unlikely — complex cross-compilation task                                                           |
| protein-assembly             | Gblock protein order wrong — flag_idx < donor_idx assertion fails                   | Maybe — domain knowledge issue, web_search might help                                               |
| query-optimize               | Solution was correct but verifier SQL runtime test took 28+ min                     | Not agent's fault — verifier timeout, agent actually solved it                                      |
| raman-fitting                | Fitting converges to wrong region (gamma=200 vs expected ~17)                       | Maybe — initial parameter guesses need guidance                                                     |
| schemelike-metacircular-eval | eval.scm passes 62/63 tests, fails on continuation_passing.scm                      | Close to passing — might just need more time or a hint on continuations                             |
| torch-tensor-parallelism     | Multi-GPU distributed ops fail, only single-process tests pass                      | Similar to pipeline-parallelism — evaluator skill might help                                        |
| tune-mjcf                    | Achieves 63.9% of reference time, needs ≤60% — barely missed target                 | Close — need slightly better tuning strategy                                                        |
| write-compressor             | data.comp causes segfault in decompressor — incorrect token structure               | Unlikely — algorithm correctness bug                                                                |

## FAIL (10 tasks)

| Task                         | Root Cause                                                                               | Fixable with skill?                                                                                       |
| ---------------------------- | ---------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| configure-git-webserver      | Evaluator passed but verifier's verify.sh returns 404 — post-push hook not serving files | Yes — evaluator skill should test the actual verify.sh behavior                                           |
| count-dataset-tokens         | Agent gets 63841 tokens, verifier expects 79586 — tokenizer mismatch                     | Yes — need to tell agent which tokenizer to use                                                           |
| cobol-modernization          | Actually passed verifier (3/3 tests) — may be a reporting bug                            | Check — might already be fixed                                                                            |
| make-mips-interpreter        | Missing stdout string "I_InitGraphics: DOOM screen size: w x h: 320 x 200"               | Skill exists (mips-interpreter-doom) but stdout forwarding still broken                                   |
| model-extraction-relu-logits | Stolen matrix rows don't match within 1e-4 tolerance for 7 rows                          | Unlikely — numerical precision issue in attack                                                            |
| mteb-leaderboard             | Context overflow (1.08M tokens) — agent fetched huge Gradio data                         | Yes — web-scraping skill exists, should prevent large fetches. Also MAX_TOOL_OUTPUT_CHARS should help now |
| mteb-retrieve                | Evaluator and verifier disagree on ground truth answer                                   | Need investigation — may be a task ambiguity                                                              |
| polyglot-c-py                | Agent left compiled binaries in /app/polyglot/ — verifier requires ONLY main.py.c        | Yes — evaluator skill: "clean up build artifacts before finishing"                                        |
| polyglot-rust-c              | Same as polyglot-c-py — compiled binaries left in output directory                       | Yes — same fix as above                                                                                   |
| sam-cell-seg                 | /app/test_output.csv not created — verifier invocation differs from what agent expected  | Maybe — skill exists but verifier's specific invocation needs matching                                    |

## Priority ranking (most likely to fix with medium-level skills)

### High priority (likely fixable)

1. **polyglot-c-py / polyglot-rust-c** — Just need to clean up build artifacts. Simple evaluator hint.
2. **count-dataset-tokens** — Tokenizer specification mismatch. Agent needs to know which tokenizer.
3. **mteb-leaderboard** — Context overflow now mitigated by MAX_TOOL_OUTPUT_CHARS. May auto-fix.
4. **configure-git-webserver** — Evaluator needs to test actual verify.sh behavior.
5. **torch-tensor-parallelism** — Similar pattern to pipeline-parallelism, skill should help.

### Medium priority (might fix)

6. **cobol-modernization** — Check if already passing, may be reporting issue.
7. **schemelike-metacircular-eval** — 62/63 tests pass, close to solution.
8. **tune-mjcf** — Barely missed target (63.9% vs 60%), small tuning might help.
9. **raman-fitting** — Initial parameter guidance could help convergence.
10. **protein-assembly** — Domain knowledge issue, web_search + fetch_url might help.

### Low priority (hard to fix with skills alone)

11. **caffe-cifar-10** — Fundamental timeout issue, needs more CPU or apt package strategy.
12. **query-optimize** — Already correct, verifier just slow.
13. **compile-compcert** — Very long build, needs precise Coq version.
14. **adaptive-rejection-sampler** — R implementation bug.
15. **sam-cell-seg** — Verifier invocation mismatch.
16. **extract-moves-from-video** — OCR strategy needs rethinking.
17. **make-mips-interpreter** — Complex stdout forwarding bug.
18. **make-doom-for-mips** — Cross-compilation complexity.
19. **gpt2-codegolf** — Code logic bug.
20. **install-windows-3-11** — QEMU version + VNC issue.
21. **write-compressor** — Algorithm correctness.
22. **model-extraction-relu-logits** — Numerical precision.
23. **mteb-retrieve** — Task ambiguity.
