import { readFile } from "node:fs/promises";
import type { TelegramMessage } from "../types/message";

interface DramaticRawDialogue {
  globalMsgId: string;
  messageId: number;
  speaker: string;
  text: string;
  sceneId: string;
  replyToMessageId: number | null;
}

export interface DramaticBenchMessage {
  messageId: number;
  // sourceMessageId: string;
  chatId: number;
  userId: string;
  context: string;
  timestamp: number;
  ground_truth_session_id: string;
  replyToMessageId: number | null;
}

class StringUnionFind {
  private parent: Map<number, number> = new Map();

  find(x: number): number {
    const existing = this.parent.get(x);
    if (!existing) {
      this.parent.set(x, x);
      return x;
    }
    if (existing === x) {
      return x;
    }
    const root = this.find(existing);
    this.parent.set(x, root);
    return root;
  }

  union(a: number, b: number): void {
    const rootA = this.find(a);
    const rootB = this.find(b);
    if (rootA !== rootB) {
      this.parent.set(rootA, rootB);
    }
  }
}

function mustHeaderIndex(headers: string[], name: string): number {
  const index = headers.indexOf(name);
  if (index < 0) {
    throw new Error(`Missing required TSV header: ${name}`);
  }
  return index;
}

function parseAnnoReply(anno: string): string | null {
  const value = anno.trim();
  if (!value) return null;
  // dramatic 数据中常见 D145 / A12 / T0 等行号
  return value;
}

function nextVirtualTimestamp(current: number): number {
  // 模拟 4~12 秒的对话间隔
  return current + Math.floor(Math.random() * 8000) + 4000;
}

export async function loadDramaticBenchmark(
  tsvPath: string
): Promise<{ messages: DramaticBenchMessage[]; telegramMessages: TelegramMessage[] }> {
  const content = await readFile(tsvPath, "utf-8");
  const lines = content.split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (lines.length === 0) {
    return { messages: [], telegramMessages: [] };
  }

  const headers = lines[0].split("\t");
  const idx = {
    lineType: mustHeaderIndex(headers, "line_type"),
    lineNo: mustHeaderIndex(headers, "line_no"),
    speaker: mustHeaderIndex(headers, "speaker_label"),
    anno: mustHeaderIndex(headers, "anno"),
    text: mustHeaderIndex(headers, "line_text"),
    scene: mustHeaderIndex(headers, "scene_id"),
  };

  const uf = new StringUnionFind();
  const rawDialogues: DramaticRawDialogue[] = [];

  const sceneIdToChatId = new Map<string, number>();
  const lineNoToMessageId = new Map<string, number>();
  let nextChatId = 1;
  let nextMessageId = 1;

  for (let i = 1; i < lines.length; i += 1) {
    const row = lines[i].split("\t");
    if (row.length < headers.length) continue;

    const lineType = (row[idx.lineType] ?? "").trim();
    const speaker = (row[idx.speaker] ?? "").trim();
    const lineNo = (row[idx.lineNo] ?? "").trim();
    const sceneId = (row[idx.scene] ?? "").trim();
    const text = (row[idx.text] ?? "").trim();
    const anno = (row[idx.anno] ?? "").trim();

    if (!speaker || !sceneId || !lineNo) continue;
    if (lineType !== "DIALOGUE") continue;

    const globalMsgId = `${sceneId}_${lineNo}`;
    const replyRaw = parseAnnoReply(anno);
    const replyToRaw = replyRaw ? `${sceneId}_${replyRaw}` : null;
    const messageId = nextMessageId++;
    lineNoToMessageId.set(globalMsgId, messageId);
    const replyToMessageId = replyToRaw ? lineNoToMessageId.get(replyToRaw): null

    rawDialogues.push({
      globalMsgId,
      messageId,
      speaker,
      text,
      sceneId,
      replyToMessageId: replyToMessageId ?? null,
    });

    if (replyToMessageId) {
      uf.union(messageId, replyToMessageId);
    }
  }

  // const idMap = new Map<string, number>();
  // for (let i = 0; i < rawDialogues.length; i += 1) {
  //   idMap.set(rawDialogues[i].globalMsgId, i + 1);
  // }

  const messages: DramaticBenchMessage[] = [];
  const telegramMessages: TelegramMessage[] = [];

  const CHAT_ID = 0;
  let virtualTimestamp = new Date("2026-03-04T12:00:00Z").getTime();

  for (const dlg of rawDialogues) {
    const messageId = dlg.messageId;
    if (!messageId) continue;
    const replyToMessageId = dlg.replyToMessageId;
    const rootId = uf.find(messageId);

    const isExplicitReply = Math.random() < 0.2;
    if (!sceneIdToChatId.has(dlg.sceneId)) {
      sceneIdToChatId.set(dlg.sceneId, nextChatId++);
    }
    const chatId = sceneIdToChatId.get(dlg.sceneId);

    messages.push({
      messageId,
      chatId: chatId ?? CHAT_ID,
      userId: dlg.speaker,
      context: dlg.text,
      timestamp: virtualTimestamp,
      ground_truth_session_id: String(rootId),
      replyToMessageId: isExplicitReply ? replyToMessageId : null,
    });

    telegramMessages.push({
      userId: dlg.speaker,
      messageId,
      chatId: chatId ?? CHAT_ID,
      conversationType: "supergroup",
      context: dlg.text,
      timestamp: virtualTimestamp,
      metadata: {
        isBot: false,
        username: null,
        replyToMessageId: isExplicitReply ? replyToMessageId : null,
        replyToUserId: null,
        isReplyToMe: false,
        isMentionMe: false,
        mentions: [],
      },
    });

    virtualTimestamp = nextVirtualTimestamp(virtualTimestamp);
  }

  return { messages, telegramMessages };
}
