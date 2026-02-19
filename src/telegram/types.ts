export type TelegramConversationType =
  | "private"
  | "group"
  | "supergroup"
  | "channel";

export interface TelegramMessage {
  userId: string;
  messageId: number;
  chatId: number;
  conversationType: TelegramConversationType;
  context: string;
  timestamp: number;
  metadata: {
    isBot: boolean;
    username: string | null;
    replyToMessageId: number | null;
    replyToUserId: string | null;
    isMentionMe: boolean;
    mentions: string[];
  };
}

export interface StreamState {
  placeholderMessageId: number;
  chunks: string[];
}

export interface TelegramAdapter {
  start: () => Promise<void>;
  stop: () => void;
  getMessages: () => TelegramMessage[];
  onMessage: (
    handler: (message: TelegramMessage) => void | Promise<void>
  ) => () => void;
  reply: (chatId: number, text: string, messageId?: number) => Promise<void>;
  startStream: (
    chatId: number,
    messageId?: number,
    placeholder?: string
  ) => Promise<void>;
  appendStream: (chatId: number, chunk: string) => void;
  endStream: (chatId: number) => Promise<string>;
}
