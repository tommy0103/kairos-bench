/**
 * Load and transform Ubuntu IRC disentangle dataset for session benchmark.
 * Parquet columns: id, raw, connections, date, ascii?, tokenized?
 */
import { parquetReadObjects } from "hyparquet";
import type { TelegramMessage } from "../types/message";
import { open, stat, writeFile } from "fs/promises";
import { dirname, join } from "node:path";

const RAW_RE = /\[(\d{2}:\d{2})\]\s*<([^>]+)>\s*(.*)/s;

export interface UbuntuRow {
  id: number;
  raw: string;
  connections: number[] | number;
  date: string;
  ascii?: string;
  tokenized?: string;
}

export interface BenchMessage {
  messageId: number;
  userId: string;
  context: string;
  timestamp: number;
  ground_truth_session_id: string;
}

function parseRaw(raw: string): { time: string; userId: string; context: string } | null {
  const m = String(raw).match(RAW_RE);
  if (!m) return null;
  return { time: m[1], userId: m[2].trim(), context: m[3].trim() };
}

function dateTimeToUnixTimestamp(dateStr: string, timeStr: string): number {
  const [year, month, day] = dateStr.split("-").map(Number);
  const [hour, minute] = timeStr.split(":").map(Number);
  const date = new Date(year, month - 1, day, hour, minute, 0, 0);
  return date.getTime();
}

class UnionFind {
  private parent: Map<number, number> = new Map();

  find(x: number): number {
    if (!this.parent.has(x)) this.parent.set(x, x);
    const p = this.parent.get(x)!;
    if (p !== x) this.parent.set(x, this.find(p));
    return this.parent.get(x)!;
  }

  union(x: number, y: number): void {
    const px = this.find(x);
    const py = this.find(y);
    if (px !== py) this.parent.set(px, py);
  }

  getRootId(x: number): number {
    return this.find(x);
  }
}

async function createLocalParquetBuffer(filePath: string) {
    const fileStat = await stat(filePath);
    const fileHandle = await open(filePath, 'r');

    return {
        byteLength: fileStat.size,
        
        slice: async (start: number, end?: number): Promise<ArrayBuffer> => {
            const readEnd = end ?? fileStat.size;
            const length = readEnd - start;
            
            const buffer = Buffer.alloc(length);
            await fileHandle.read(buffer, 0, length, start);
            
            return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
        }
    };
}

function toConnectionsArray(connections: number[] | number | unknown): number[] {
  if (Array.isArray(connections)) return connections.map(Number);
  if (typeof connections === "number") return [connections];
  return [];
}

/** 去掉句首 "Kamion: " 这类 mention，只保留后面的内容。 */
function stripLeadingMention(context: string): string {
  const s = String(context).trim();
  const m = s.match(/^\s*\S+:\s*/);
  return m ? s.slice(m[0].length).trim() : s;
}

/** IRC 系统消息（join/part/quit 等），不参与 session 基准。 */
function isIrcSystemMessage(raw: string): boolean {
  const s = String(raw).trim();
  if (s.startsWith("===")) return true;
  if (/\b(has joined|has left|has quit|has parted|has changed topic|has set mode|was kicked)\b/i.test(s)) return true;
  return false;
}

export async function loadUbuntuTrainParquet(
  parquetPath: string
): Promise<{ messages: BenchMessage[]; telegramMessages: TelegramMessage[] }> {
  const file = await createLocalParquetBuffer(parquetPath);
  const rows = (await parquetReadObjects({ file })) as UbuntuRow[];

  const rawLimit = 5000;
  const rawHead = rows.slice(0, rawLimit).map((r) => ({
    id: r.id,
    raw: r.raw,
    connections: toConnectionsArray(r.connections),
    date: r.date,
    ascii: r.ascii,
    tokenized: r.tokenized,
  }));
  const rawOutPath = join(dirname(parquetPath), "train-raw-5000.json");
  await writeFile(
    rawOutPath,
    JSON.stringify({ rows: rawHead }, null, 2),
    "utf-8",
  );

  const uf = new UnionFind();
  for (const row of rows) {
    const id = Number(row.id);
    const conns = toConnectionsArray(row.connections);
    for (const c of conns) {
      uf.union(id, Number(c));
    }
  }

  const CHAT_ID = 0;
  const defaultMetadata: TelegramMessage["metadata"] = {
    isBot: false,
    username: null,
    replyToMessageId: null,
    replyToUserId: null,
    isReplyToMe: false,
    isMentionMe: false,
    mentions: [],
  };

  const messages: BenchMessage[] = [];
  const telegramMessages: TelegramMessage[] = [];

  for (const row of rows) {
    if (isIrcSystemMessage(row.raw)) continue;

    const parsed = parseRaw(row.ascii ?? row.raw);
    const userId = parsed?.userId ?? `user_${row.id}`;
    let context = parsed?.context ?? row.raw;
    context = stripLeadingMention(context);
    const timeStr = parsed?.time ?? "00:00";
    const timestamp = dateTimeToUnixTimestamp(row.date, timeStr);
    const ground_truth_session_id = String(uf.getRootId(Number(row.id)));

    messages.push({
      messageId: row.id,
      userId,
      context,
      timestamp,
      ground_truth_session_id,
    });

    telegramMessages.push({
      userId,
      messageId: row.id,
      chatId: CHAT_ID,
      conversationType: "supergroup",
      context,
      timestamp,
      metadata: { ...defaultMetadata },
    });
  }

  // telegramMessages.sort((a, b) => a.timestamp - b.timestamp);
  // messages.sort((a, b) => a.timestamp - b.timestamp);

  const limit = 3000;
  const headMessages = messages.slice(0, limit);
  const headTelegramMessages = telegramMessages.slice(0, limit);
  const outPath = join(dirname(parquetPath), "train-first-3000.json");
  await writeFile(
    outPath,
    JSON.stringify(
      { messages: headMessages, telegramMessages: headTelegramMessages },
      null,
      2,
    ),
    "utf-8",
  );

  return { messages, telegramMessages };
}
