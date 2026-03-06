export interface LocalModelAttachment {
  type: "image" | "audio" | "file";
  path: string;
  mimeType?: string;
}

export interface LocalModelCompleteInput {
  prompt: string;
  attachments?: LocalModelAttachment[];
}

export interface LocalModelCompleteOutput {
  text: string;
}

export interface LocalModel {
  complete(input: LocalModelCompleteInput): Promise<LocalModelCompleteOutput>;
}

export type CloudModel = LocalModel;
