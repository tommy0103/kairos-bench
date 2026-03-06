/**
 * Session segmentation benchmark: ingest Ubuntu train set into ContextStore,
 * measure total time and Pairwise F1 against ground-truth sessions.
 *
 * Run: bun run src/bench/sessionBenchmark.ts
 * Optional: BENCH_PARQUET=/path/to/train.parquet (default: irc_disentangle/ubuntu/train-00000-of-00001.parquet)
 */
import { join } from "node:path";
import { createInMemoryContextStore } from "../gateway/context";
import { loadUbuntuTrainParquet } from "./ubuntuDataset";
import { loadDramaticBenchmark } from "./dramaticDataset";
import { pairwiseF1 } from "./pairwiseF1";
import { createOllamaDenseEmbedder } from "../model/embedding"; 
import { createOllamaLocalModel, createOpenAICloudModel } from "../model/llm";

const DEFAULT_PARQUET = join(
  process.cwd(),
  "irc_disentangle",
  "ubuntu",
  "train-00000-of-00001.parquet"
);

const DEFAULT_DRAMATIC_PATH = join(
  process.cwd(),
  "dramatic-conversation-disentanglement",
  "data",
  "train.tsv"
);

async function main(): Promise<void> {
  const parquetPath = process.env.BENCH_PARQUET ?? DEFAULT_PARQUET;
  const dramaticPath = process.env.BENCH_DRAMATIC_PATH ?? DEFAULT_DRAMATIC_PATH;
  console.log("[bench] Loading dataset:", parquetPath);

  // const { messages, telegramMessages } = await loadUbuntuTrainParquet(parquetPath);
  const { messages, telegramMessages } = await loadDramaticBenchmark(dramaticPath);
  console.log("[bench] Loaded messages:", telegramMessages.length);

  // for (const msg of telegramMessages.slice(0, 10)) {
  //   console.log("msg", msg);
  // }
  // console.log("msg", telegramMessages[82]);

  // const contextStore = createInMemoryContextStore({
  //   embedder: createOllamaDenseEmbedder({
  //     // model: "nomic-embed-text"
  //     model: "qwen3-embedding:0.6b"
  //   }),
  //   similarityThreshold: 0.75,
  //   shortMessageThreshold: 0.65,
  //   // use default embedder (ollama); ensure OLLAMA is running with bge-m3
  // });

    const contextStore = createInMemoryContextStore({
    embedder: createOllamaDenseEmbedder({
      model: "qwen3-embedding:0.6b"
      // model: "bge-m3"
    }),
    similarityThreshold: 0.60,
    shortMessageThreshold: 0.45,
    localModel: createOllamaLocalModel(),
    // cloudModel: createOpenAICloudModel({
    //   apiKey: process.env.ARK_API_KEY,
    //   baseURL: "https://ark.cn-beijing.volces.com/api/v3",
    //   model: "doubao-seed-2-0-lite-260215",
    // }),
  });

  const start = performance.now();
  // const [L, R] = [0, telegramMessages.length];
  // const [L, R] = [0, 1000];
  // const [L, R] = [50, 100];
  const [L, R] = [0, 500];
  for (const [index, msg] of telegramMessages.slice(L, R).entries()) {
    console.log("ingestMessage", index);
    if(index % 1000 == 0) {
      console.log("ingestMessage", index);
    }
    await contextStore.ingestMessage({ message: msg });
  }
  const elapsed = performance.now() - start;
  console.log("[bench] Ingest total time (ms):", Math.round(elapsed));
  console.log("[bench] Ingest avg per message (ms):", (elapsed / telegramMessages.length).toFixed(2));


  // contextStore.debugPrintSessionControlBlocks();

  const getSessionId = contextStore.getSessionIdForMessage;
  if (!getSessionId) {
    console.warn("[bench] ContextStore has no getSessionIdForMessage, skipping F1.");
    return;
  }

  const CHAT_ID = 0;
  // const messageIds = messages.map((m) => m.messageId).slice(L, R);
  const gtMap = new Map(messages.map((m) => [m.messageId, m.ground_truth_session_id]));
  const getGroundTruthSessionId = (messageId: number) => gtMap.get(messageId) ?? "";
  const getPredictedSessionId = (messageId: number, chatId: number) => getSessionId({ chatId: chatId, messageId });

  const { precision, recall, f1 } = pairwiseF1(
    messages.slice(L, R),
    getGroundTruthSessionId,
    getPredictedSessionId
  );

  console.log("[bench] Pairwise F1 — precision:", precision.toFixed(4), "recall:", recall.toFixed(4), "f1:", f1.toFixed(4));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
