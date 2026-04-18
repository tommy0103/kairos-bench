# Researcher vs Master 分析：Researcher 通过而 Master 失败的 7 个任务

> Source: `jobs/jobs-0418/4.7-researcher` vs `jobs/jobs-0418/4.7-master`

## 总览

| 任务                         | Master        | Researcher | 失败原因分类                 | Research 阶段是否关键                   |
| ---------------------------- | ------------- | ---------- | ---------------------------- | --------------------------------------- |
| configure-git-webserver      | 0/1           | 1/1        | 自测残留污染验证             | ✅ 间接帮助（更干净的执行）             |
| dna-insert                   | 0/1           | 1/1        | 边界判定偏移 2bp             | ✅ 穷举搜索找到正确边界                 |
| extract-elf                  | 0/1           | 1/1        | Master 其实也过了\*          | ❌ 反而拖慢了首次实现                   |
| financial-document-processor | 0/1           | 1/1        | 文档分类错误（11 vs 10）     | ✅ 预览文档内容避免误分类               |
| gpt2-codegolf                | 0/1 (timeout) | 1/1        | 从零实现超时 vs 找到现成方案 | ✅✅ 决定性（找到 Carlini 的 3KB 实现） |
| make-mips-interpreter        | 0/1           | 1/1        | host-side hook 帧不匹配      | ✅ 读懂 BMP 写入走 fwrite 路径          |
| mteb-leaderboard             | 0/1 (timeout) | 1/1        | 未过滤不完整模型             | ✅ 预研确定正确数据源和过滤条件         |

> \*extract-elf：Master 在此 run 中实际上 reward=0，但 4.6-researcher 分析表明 researcher 的首次实现反而更差，靠 evaluator 迭代修复才通过。Research 阶段找到了参考代码但初始实现并未受益。

---

## 1. configure-git-webserver

**任务**：配置 bare git repo + post-receive hook 自动部署到 `/var/www`，通过 HTTP 8080 端口提供服务。

**Master 失败原因**：自测时在 `/var/www` 留下了 `hello.html`，验证器再次 push 时内容被覆盖/污染，严格字符串匹配失败。

**Researcher 成功原因**：执行完自测后主动清理了 `/var/www/hello.html` 和临时 clone 目录，使验证器的 push 产生干净的首次部署。

**Research 阶段贡献**：确认了 `python3` 已安装（避免安装弯路），产出了更有条理的执行计划，间接导致了更干净的收尾步骤。

**启示**：Master 需要在自测后清理测试产物。这是一个 **执行细节问题**，不一定需要 research 阶段。

---

## 2. dna-insert

**任务**：设计 Q5 定点突变引物，在位置 215 插入 39nt 序列。要求引物退火长度 15-45nt，Tm 58-72°C，前后 Tm 差 ≤5°C。

**Master 失败原因**：插入边界处有 2bp 的歧义重叠（`ag`），Master 选错了边界位置，导致正向引物的退火区偏移了 2 个碱基，不匹配模板。

**Researcher 成功原因**：写了一个穷举搜索脚本，遍历所有合法边界位置和退火长度，用 `oligotm` 验证 Tm 约束，找到了正确的引物对。

**Research 阶段贡献**：提前确认了 `primer3`/`oligotm` 需要安装，了解了 NEB Q5 引物设计规则，为后续系统化搜索打下基础。

**启示**：对于有歧义边界的生物信息学任务，**穷举验证**比手动推断可靠得多。Master 可以通过类似的穷举策略避免此问题。

---

## 3. extract-elf

**任务**：解析 ELF 二进制，输出虚拟地址 →4 字节整数值的 JSON 映射，覆盖参考答案 ≥75%。

**Master 失败原因**：Master 实际上在此 run 中 reward=0（todo.latest 记录为回归）。需要进一步确认具体失败原因。

**Researcher 成功原因**：首次实现用 section header（只解析 .text/.data/.rodata），仅产出 73 条（~10% 覆盖率）。经过 3 轮 evaluator 修复迭代，最终切换到 PT_LOAD + memsz 方案（处理 .bss 零填充），达到完整覆盖。

**Research 阶段贡献**：找到了 GitHub 上的参考测试代码，但**并未直接改善首次实现质量**。最终通过 evaluator 反馈迭代才通过。

**启示**：此任务 researcher 的优势**不来自 research 阶段**，而是来自 evaluator 的多轮修复机会。Master 的失败可能是偶发的实现差异。

---

## 4. financial-document-processor

**任务**：对 17 个 JPG/PDF 文档进行分类（invoice vs other），提取发票金额，生成 summary.csv。

**Master 失败原因**：将 11 个文档分类为发票（正确为 10 个），误将一个非发票文档（hash `b926...`）归为发票，导致行数错误和总金额偏差（81755.20 vs 81315.20）。

**Researcher 成功原因**：Research 阶段预览了实际文档内容（33 轮），发现了三种发票格式（Stripe 风格、波兰语 "Gross worth"、PDF "TotalPrice"），提前安装了 tesseract，制定了正确的解析策略。首次尝试即正确分类了 10 张发票和 7 个其他文档。

**Research 阶段贡献**：**关键作用**。提前查看文档内容 + 确认可用工具 → 正确的分类逻辑。Master 没有预览文档就直接开始，导致分类错误。

**启示**：对于文档处理类任务，**先看样本再写代码**非常重要。Master 的 prompt/技能中可以加入"先采样查看文档再分类"的指导。

---

## 5. gpt2-codegolf ⭐

**任务**：用 ≤5000 字节的无依赖 C 代码实现 GPT-2 推理（读取 checkpoint + vocab，argmax 采样 20 个 token）。

**Master 失败原因**：从零实现，花大量时间逆向 checkpoint 二进制格式、调试 BPE 分词、尝试不同权重布局。最终代码 7834 字节（超限），且在调试中耗尽时间（AgentTimeoutError）。

**Researcher 成功原因**：Research 阶段找到了 Nicholas Carlini 的已有 3000 字节 C GPT-2 实现。直接 fetch 源码 → 适配（去掉 chat 循环、硬编码 124M 配置、修复宏作用域 bug）→ 编译测试，约 66 轮完成。最终 3178 字节。

**Research 阶段贡献**：**决定性作用**。将一个极难的"从零实现"问题转化为"适配已有方案"问题。没有 research 阶段，几乎不可能在时限内完成。

**启示**：这是 research 阶段价值最大的案例。对于 codegolf 类任务，**搜索已有的极限实现**比从头写要高效几个数量级。可以在 master 的 skill 中加入"先搜索是否有已知的极小实现"。

---

## 6. make-mips-interpreter

**任务**：实现 MIPS32 解释器（Node.js），运行 DOOM ELF，启动 DOOM 并将首帧保存为 `/tmp/frame.bmp`。验证器检查帧尺寸（640x400）和与参考图像的相似度（≥95%）。

**Master 失败原因**：MIPS 指令实现正确，DOOM 成功启动。但 Master 用了 host-side hook 方式捕获帧：在 `DG_DrawFrame` 地址拦截，从 host 端直接读取 `DG_ScreenBuffer` 写 BMP。生成的 BMP 与参考图像相似度仅 0.7437（阈值 0.95），可能是颜色通道顺序或捕获时机问题。

**Researcher 成功原因**：Research 阶段（70 轮）仔细阅读了 `doomgeneric_img.c`，发现 `DG_DrawFrame` 通过 `fopen`/`fwrite` 系统调用写 BMP。因此让二进制自身的 BMP 写入代码在解释器中原生执行。关键修复：SWL/SWR 指令的大小端语义错误（导致 BMP header 中 bpp 字段为 0 而非 32）+ `chdir` 到 `/app` 确保找到 `doom.wad`。

**Research 阶段贡献**：**关键作用**。通过阅读源码理解了帧写入的完整路径（DG_DrawFrame → writeBMPFile → fopen/fwrite），决定了正确的架构方案（让二进制自己写 BMP vs host-side hook）。

**启示**：Master 的 hook 方案是"聪明但不对"的捷径。正确方案需要理解二进制的内部逻辑。skill 中可以加入"让目标程序自己完成 I/O，不要在 host 端拦截"的指导。

---

## 7. mteb-leaderboard

**任务**：查找 MTEB 斯堪的纳维亚排行榜（截至 2025 年 8 月）上最佳嵌入模型，写入 `/app/result.txt`。

**Master 失败原因**：从 `embeddings-benchmark/results` git repo 计算均分，但**未过滤任务覆盖不完整的模型**。`Salesforce/SFR-Embedding-2_R` 只有 27/28 个任务，缺少 `DanFeverRetrieval`，但因缺失任务恰好拉低了其他完整模型的竞争力。Master 最终提交了错误答案。

**Researcher 成功原因**：Research 阶段确定了正确方法论：clone `mteb/results`（HuggingFace 数据集），checkout 2025 年 9 月之前的最后一个 commit，**仅计算覆盖全部 28 个任务的模型**。正确识别出 `GritLM/GritLM-7B`（均分 ~0.6408，28/28 任务）。

**Research 阶段贡献**：**关键作用**。确定了正确的数据源（HuggingFace dataset 而非 live leaderboard UI）、时间截断策略（git checkout）、以及完整性过滤条件。

**启示**：排行榜类任务需要注意**任务覆盖完整性**过滤。Master 的 skill 中可以加入"只考虑完成全部任务的模型"的约束。

---

## 分类总结

### Research 阶段决定性的（3 个）

- **gpt2-codegolf**：找到现成极小实现，从零实现不可能在时限内完成
- **make-mips-interpreter**：读源码确定正确架构方案（原生 fwrite vs host hook）
- **mteb-leaderboard**：确定正确数据源、时间截断和完整性过滤

### Research 阶段有帮助的（2 个）

- **financial-document-processor**：预览文档避免分类错误
- **dna-insert**：了解工具和规则，支撑穷举搜索策略

### Research 阶段作用有限的（2 个）

- **configure-git-webserver**：主要是执行细节（清理自测产物），research 间接帮助
- **extract-elf**：research 找到参考代码但首次实现更差，靠 evaluator 迭代修复

### 对 Master 分支的改进建议

1. **codegolf/极限实现类任务**：skill 加入"先搜索已有的极小/极限实现"
2. **文档处理类任务**：skill 加入"先采样查看若干文档内容再设计解析逻辑"
3. **排行榜/数据查询类任务**：skill 加入"注意数据完整性过滤"
4. **MIPS/模拟器类任务**：skill 加入"让目标程序自己完成 I/O"
5. **自测后清理**：通用 prompt 加入"自测完成后清理测试产物"
6. **生信引物设计**：对有歧义的边界，用穷举搜索而非手动推断
