/**
 * Researcher agent — runs before the generator to gather domain knowledge.
 *
 * The researcher searches the web, reads documentation, and inspects the
 * container environment to understand the task's key concepts, tools,
 * file formats, and APIs. Its findings are passed to the generator via
 * the system prompt so the generator doesn't waste time on research.
 *
 * The researcher is lightweight (120s, ~20 turns) and should NOT design
 * solutions — only gather and summarize relevant knowledge.
 */
import type OpenAI from "openai";
import type { ChatClient } from "../core/chatClient";
import { reactLoop } from "../core/reactLoop";
import type { AgentTool, LogosCompleteParams } from "../core/types";

const RESEARCHER_TIMEOUT_MS = 360_000;
const RESEARCHER_MAX_TURNS = 20;
const RESEARCHER_EXEC_TIMEOUT_MS = 40_000;

export interface ResearchResult {
  reply: string;
  taskLog?: string;
  turns: number;
}

function buildResearcherPrompt(
  taskDescription: string,
  kernelMode: boolean
): string {
  const toolDocs = kernelMode
    ? `## Tools

1. **logos_exec(command)** — Execute a shell command to inspect the environment (check installed tools, read files, etc.).
2. **logos_read(uri)** — Read from a Logos URI.
3. **logos_call(tool, params)** — Invoke a proc tool. Available:
   - \`web_search\`: search the web. Params: \`{"query": "...", "max_results": 5}\`
   - \`fetch_url\`: fetch a URL and return content as text. Params: \`{"url": "https://..."}\`
4. **logos_complete(...)** — MANDATORY final call.`
    : `## Tools

- **logos_exec(command)** — Execute a shell command.
- **logos_complete(...)** — MANDATORY final call.`;

  return `You are a research assistant preparing background knowledge for a task-solving agent.

## Task to research

${taskDescription}

${toolDocs}

## Your job

Read the task instructions carefully. Identify the parts that are **most confusing, ambiguous, or likely to trip up someone working on this task** — these are what you should research. Tasks span many domains (software engineering, bioinformatics, cryptography, physics, ML, system administration, etc.), so the tricky parts could be anything: an unfamiliar file format, a domain-specific convention, a library with surprising API behavior, a scientific method with specific requirements.

Your research will be handed to the agent who actually solves the task. Focus on what would help them the most.

**What to do**:
1. **Read the instructions and ask yourself: what would I need to look up if I were solving this?** Focus on the parts you are least confident about.
2. Use \`web_search\` and \`fetch_url\` to look up those specific things — file formats, library APIs, scientific conventions, mathematical methods, protocol specifications, domain-specific terminology, etc.
3. Use \`logos_exec\` to **verify your findings against the actual files in the container** — e.g. inspect file headers (\`hexdump -C file | head -20\`), check file sizes, read source code. Do not trust search results alone.
4. If the task mentions a specific file format (e.g. ".ckpt", ".pdb", ".wad"), inspect the actual file to confirm it matches what you found online. If it doesn't match, your research is wrong — keep looking.

**What NOT to do**:
- Do NOT write solution code or design an implementation
- Do NOT modify any files in /app
- Do NOT spend more than 2-3 searches per concept — stay fast
- Do NOT assume a file format based on similar-looking projects — always verify against the actual file
- If the task is straightforward and doesn't need research, call logos_complete immediately

## Output format

Call \`logos_complete\` with:
- \`reply\`: A concise summary of your findings that will be shown directly to the coding agent. Include:
  - Key facts the agent needs to know (technical details, domain knowledge, scientific background)
  - Links to useful documentation pages you found
  - Any gotchas or common mistakes you discovered
- \`task_log\`: Detailed notes from your research (full page contents, detailed API docs, etc.)
- \`summary\`: One-line description of what you researched

The coding agent will see your \`reply\` in its system prompt. It can also read your detailed \`task_log\` via \`logos_read\` if it needs more depth.

**You have a strict time budget. After each tool call you will see how much time and how many turns remain. When time is running low, immediately call logos_complete with whatever you have found so far.**`;
}

export async function runResearcher(opts: {
  client: ChatClient;
  model: string;
  tools: AgentTool[];
  taskDescription: string;
  kernelMode: boolean;
}): Promise<ResearchResult> {
  const { client, model, tools, taskDescription, kernelMode } = opts;

  const allowedTools = new Set([
    "logos_exec",
    "logos_read",
    "logos_call",
    "logos_complete",
  ]);
  const filteredTools = tools
    .filter((t) => allowedTools.has(t.name))
    .map((t) => {
      if (t.name === "logos_exec") {
        const origExecute = t.execute;
        return {
          ...t,
          description:
            t.description.replace(/\d+ second timeout/, `${RESEARCHER_EXEC_TIMEOUT_MS / 1000} second timeout`),
          execute: (id: string, params: Record<string, unknown>, signal?: AbortSignal) => {
            return Promise.race([
              origExecute(id, params, signal),
              new Promise<never>((_, reject) =>
                setTimeout(
                  () => reject(new Error(`researcher logos_exec timed out after ${RESEARCHER_EXEC_TIMEOUT_MS / 1000}s`)),
                  RESEARCHER_EXEC_TIMEOUT_MS,
                ),
              ),
            ]).catch((err) => ({
              content: [{ type: "text" as const, text: `exit_code: -1 (TIMEOUT after ${RESEARCHER_EXEC_TIMEOUT_MS / 1000}s)\n\nCommand timed out. Use shorter commands.` }],
            }));
          },
        } as AgentTool;
      }
      return t;
    });

  const systemPrompt = buildResearcherPrompt(taskDescription, kernelMode);

  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    { role: "system", content: systemPrompt },
    { role: "user", content: taskDescription },
  ];

  const abortController = new AbortController();
  const hardTimer = setTimeout(() => {
    console.log(
      `[researcher] hard deadline reached, aborting current operation`
    );
    abortController.abort();
  }, RESEARCHER_TIMEOUT_MS + 60_000);

  const loop = reactLoop({
    client,
    model,
    messages,
    tools: filteredTools,
    maxTurns: RESEARCHER_MAX_TURNS,
    temperature: 0.2,
    signal: abortController.signal,
  });

  let turns = 0;
  let toolCalls = 0;
  let completeParams: LogosCompleteParams | undefined;
  let urgentInjected = false;
  const startTime = Date.now();
  const timeoutAt = startTime + RESEARCHER_TIMEOUT_MS;
  const urgentAt = startTime + Math.round(RESEARCHER_TIMEOUT_MS * 0.8);

  try {
    for await (const event of loop) {
      turns++;

      switch (event.type) {
        case "tool_execution_start": {
          const raw = JSON.stringify(event.params);
          const args =
            raw.length > 200
              ? raw.slice(0, 200) + `… (${raw.length} bytes total)`
              : raw;
          console.log(`  [research] ${event.toolName}(${args})`);
          break;
        }
        case "tool_execution_end":
          if (event.toolName !== "logos_complete") {
            const text =
              typeof event.result === "object" && event.result !== null
                ? (event.result as any)?.content?.[0]?.text ?? ""
                : String(event.result ?? "");
            const preview =
              text.length > 300 ? text.slice(0, 300) + "..." : text;
            console.log(`  [research-result] ${preview}`);

            toolCalls++;
            const elapsedSec = Math.round((Date.now() - startTime) / 1000);
            const remainingSec = Math.max(
              0,
              Math.round((timeoutAt - Date.now()) / 1000)
            );
            const remainingTurns = RESEARCHER_MAX_TURNS - turns;

            if (!urgentInjected && Date.now() > urgentAt) {
              urgentInjected = true;
              console.log(
                `[researcher] time almost up, injecting urgent message`
              );
              messages.push({
                role: "user" as const,
                content:
                  `⚠️ TIME IS ALMOST UP (${remainingSec}s remaining). You MUST call logos_complete NOW with your findings so far. ` +
                  `Do not make any more tool calls. Summarize everything you have learned and call logos_complete immediately.`,
              });
            } else if (Date.now() > timeoutAt) {
              console.log(`[researcher] time expired, forcing completion`);
              messages.push({
                role: "user" as const,
                content: `🛑 TIME IS UP. Call logos_complete RIGHT NOW with whatever you have. Do NOT call any other tool.`,
              });
            } else {
              messages.push({
                role: "user" as const,
                content: `⏱ ${remainingSec}s remaining, ~${remainingTurns} turns remaining (${toolCalls} tool calls used, ${elapsedSec}s elapsed)`,
              });
            }
          }
          break;
        case "logos_complete":
          completeParams = event.params;
          console.log(`  [research-complete] ${event.params.summary}`);
          break;
        case "max_turns_reached":
          console.log(
            `[researcher] max turns (${RESEARCHER_MAX_TURNS}) reached`
          );
          break;
      }
    }
  } catch (err) {
    if (abortController.signal.aborted) {
      console.log(`[researcher] aborted by hard deadline`);
    } else {
      throw err;
    }
  } finally {
    clearTimeout(hardTimer);
  }

  if (!completeParams) {
    return { reply: "", turns };
  }

  return {
    reply: completeParams.reply ?? completeParams.summary ?? "",
    taskLog: completeParams.task_log,
    turns,
  };
}
