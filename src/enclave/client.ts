import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  AgentEnclaveClient,
  EnclaveStreamEvent,
  StreamReplyRequest,
} from "./protocol";

const CURRENT_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_PROTO_PATH = resolve(CURRENT_DIR, "../agent/proto/enclave.proto");
const MAX_GRPC_MESSAGE_BYTES = 16 * 1024 * 1024;

interface CreateGrpcEnclaveClientOptions {
  target: string;
  protoPath?: string;
  metadata?: Record<string, string>;
}

interface GrpcStreamReplyRequest {
  chat_id: string;
  messages: Array<{
    role: string;
    content: string;
  }>;
}

interface GrpcStreamReplyEvent {
  type?: string;
  role?: string;
  delta?: string;
  tool_name?: string;
  tool_call_id?: string;
  result_json?: string;
  error?: string;
}

interface GrpcServiceClient {
  StreamReply(
    request: GrpcStreamReplyRequest,
    metadata?: grpc.Metadata
  ): grpc.ClientReadableStream<GrpcStreamReplyEvent>;
}

let grpcClientCtor: grpc.ServiceClientConstructor | null = null;

function getGrpcClientCtor(protoPath: string): grpc.ServiceClientConstructor {
  if (grpcClientCtor) {
    return grpcClientCtor;
  }
  const packageDefinition = protoLoader.loadSync(protoPath, {
    keepCase: true,
    longs: String,
    enums: String,
    defaults: true,
    oneofs: true,
  });
  const loaded = grpc.loadPackageDefinition(packageDefinition) as {
    memoh_lite?: {
      enclave?: {
        v1?: {
          AgentEnclaveService?: grpc.ServiceClientConstructor;
        };
      };
    };
  };
  const ctor = loaded.memoh_lite?.enclave?.v1?.AgentEnclaveService;
  if (!ctor) {
    throw new Error("Failed to load AgentEnclaveService from proto definition.");
  }
  grpcClientCtor = ctor;
  return ctor;
}

function toGrpcRequest(request: StreamReplyRequest): GrpcStreamReplyRequest {
  return {
    chat_id: String(request.chatId),
    messages: request.messages.map((item) => ({
      role: item.role,
      content: item.content,
    })),
  };
}

function toMetadata(data?: Record<string, string>): grpc.Metadata | undefined {
  if (!data || Object.keys(data).length === 0) {
    return undefined;
  }
  const metadata = new grpc.Metadata();
  for (const [key, value] of Object.entries(data)) {
    metadata.set(key, value);
  }
  return metadata;
}

function mapGrpcEvent(event: GrpcStreamReplyEvent): EnclaveStreamEvent {
  const type = event.type ?? "";
  if (type === "message_update") {
    return {
      type: "message_update",
      role: "assistant",
      delta: event.delta ?? "",
    };
  }
  if (type === "tool_execution_start") {
    return {
      type: "tool_execution_start",
      toolName: event.tool_name ?? "",
      toolCallId: event.tool_call_id,
    };
  }
  if (type === "tool_execution_end") {
    let result: unknown;
    if (event.result_json) {
      try {
        result = JSON.parse(event.result_json);
      } catch {
        result = event.result_json;
      }
    }
    return {
      type: "tool_execution_end",
      toolName: event.tool_name ?? "",
      toolCallId: event.tool_call_id,
      result,
    };
  }
  if (type === "failed") {
    return {
      type: "failed",
      error: event.error ?? "AgentEnclave stream failed.",
    };
  }
  return { type: "completed" };
}

async function* streamFromGrpc(
  client: GrpcServiceClient,
  request: StreamReplyRequest,
  metadata?: grpc.Metadata
): AsyncGenerator<EnclaveStreamEvent, void, unknown> {
  const call = client.StreamReply(toGrpcRequest(request), metadata);
  try {
    for await (const rawEvent of call as AsyncIterable<GrpcStreamReplyEvent>) {
      yield mapGrpcEvent(rawEvent);
    }
  } catch (error) {
    yield {
      type: "failed",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export function createGrpcEnclaveClient(
  options: CreateGrpcEnclaveClientOptions
): AgentEnclaveClient {
  const protoPath = options.protoPath ?? DEFAULT_PROTO_PATH;
  const ServiceCtor = getGrpcClientCtor(protoPath);
  const client = new ServiceCtor(
    options.target,
    grpc.credentials.createInsecure(),
    {
      "grpc.max_send_message_length": MAX_GRPC_MESSAGE_BYTES,
      "grpc.max_receive_message_length": MAX_GRPC_MESSAGE_BYTES,
    }
  ) as unknown as GrpcServiceClient;
  const metadata = toMetadata(options.metadata);
  return {
    streamReply: (request: StreamReplyRequest) =>
      streamFromGrpc(client, request, metadata),
  };
}
