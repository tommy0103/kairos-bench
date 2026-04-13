/**
 * TypeScript gRPC client for the Logos kernel.
 *
 * Connects via Unix Domain Socket. Supports the full agent primitive set
 * (Read, Write, Patch, Exec, Call) plus management RPCs (RegisterToken,
 * Handshake, RevokeToken).
 *
 * Session lifecycle:
 *   1. Runtime calls registerToken() to create a one-time token
 *   2. Client calls handshake(token) to obtain a session key
 *   3. Session key is injected as `x-logos-session` metadata on all agent calls
 */
import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const CURRENT_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_PROTO_PATH = resolve(
  CURRENT_DIR,
  "../../../vfs/proto/logos.proto"
);
const SESSION_METADATA_KEY = "x-logos-session";

export interface LogosClientOptions {
  socketPath: string;
  protoPath?: string;
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  exit_code: number;
}

export interface LogosClient {
  read(uri: string): Promise<string>;
  write(uri: string, content: string): Promise<void>;
  patch(uri: string, partial: string): Promise<void>;
  exec(command: string): Promise<ExecResult>;
  call(tool: string, params: Record<string, unknown>): Promise<unknown>;
  registerToken(
    token: string,
    taskId: string,
    role: string,
    agentConfigId: string
  ): Promise<void>;
  handshake(token: string): Promise<void>;
  revokeToken(token: string): Promise<void>;
  hasSession(): boolean;
  clearSession(): void;
  close(): void;
}

type GrpcCallback<T> = (error: grpc.ServiceError | null, response: T) => void;

interface LogosGrpcClient {
  Read(
    req: { uri: string },
    metadata: grpc.Metadata,
    cb: GrpcCallback<{ content: string }>
  ): void;
  Write(
    req: { uri: string; content: string },
    metadata: grpc.Metadata,
    cb: GrpcCallback<Record<string, never>>
  ): void;
  Patch(
    req: { uri: string; partial: string },
    metadata: grpc.Metadata,
    cb: GrpcCallback<Record<string, never>>
  ): void;
  Exec(
    req: { command: string },
    metadata: grpc.Metadata,
    cb: GrpcCallback<{ stdout: string; stderr: string; exit_code: number }>
  ): void;
  Call(
    req: { tool: string; params_json: string },
    metadata: grpc.Metadata,
    cb: GrpcCallback<{ result_json: string }>
  ): void;
  Handshake(
    req: { token: string },
    metadata: grpc.Metadata,
    cb: GrpcCallback<{ ok: boolean; error: string }>
  ): void;
  RegisterToken(
    req: {
      token: string;
      task_id: string;
      role: string;
      agent_config_id: string;
    },
    metadata: grpc.Metadata,
    cb: GrpcCallback<Record<string, never>>
  ): void;
  RevokeToken(
    req: { token: string },
    metadata: grpc.Metadata,
    cb: GrpcCallback<Record<string, never>>
  ): void;
  close(): void;
}

function promisify<TReq, TRes>(
  client: LogosGrpcClient,
  method: (
    req: TReq,
    metadata: grpc.Metadata,
    cb: GrpcCallback<TRes>
  ) => void,
  req: TReq,
  metadata: grpc.Metadata
): Promise<TRes> {
  return new Promise((resolve, reject) => {
    method.call(client, req, metadata, (err, res) => {
      if (err) reject(err);
      else resolve(res);
    });
  });
}

export function createLogosClient(options: LogosClientOptions): LogosClient {
  const protoPath = options.protoPath ?? DEFAULT_PROTO_PATH;

  const packageDefinition = protoLoader.loadSync(protoPath, {
    keepCase: true,
    longs: String,
    enums: String,
    defaults: true,
    oneofs: true,
  });

  const loaded = grpc.loadPackageDefinition(packageDefinition) as any;
  const LogosService = loaded.logos?.kernel?.v1?.Logos;
  if (!LogosService) {
    throw new Error(
      "Failed to resolve logos.kernel.v1.Logos from proto definition"
    );
  }

  const target = options.socketPath.startsWith("unix:")
    ? options.socketPath
    : `unix:${options.socketPath}`;

  const grpcClient: LogosGrpcClient = new LogosService(
    target,
    grpc.credentials.createInsecure()
  );

  let sessionKey: string | undefined;

  function sessionMeta(): grpc.Metadata {
    const meta = new grpc.Metadata();
    if (sessionKey) {
      meta.set(SESSION_METADATA_KEY, sessionKey);
    }
    return meta;
  }

  function emptyMeta(): grpc.Metadata {
    return new grpc.Metadata();
  }

  const client: LogosClient = {
    async read(uri) {
      const res = await promisify(
        grpcClient,
        grpcClient.Read,
        { uri },
        sessionMeta()
      );
      return res.content;
    },

    async write(uri, content) {
      await promisify(
        grpcClient,
        grpcClient.Write,
        { uri, content },
        sessionMeta()
      );
    },

    async patch(uri, partial) {
      await promisify(
        grpcClient,
        grpcClient.Patch,
        { uri, partial },
        sessionMeta()
      );
    },

    async exec(command) {
      const res = await promisify(
        grpcClient,
        grpcClient.Exec,
        { command },
        sessionMeta()
      );
      return {
        stdout: res.stdout,
        stderr: res.stderr,
        exit_code: res.exit_code,
      };
    },

    async call(tool, params) {
      const res = await promisify(
        grpcClient,
        grpcClient.Call,
        { tool, params_json: JSON.stringify(params) },
        sessionMeta()
      );
      try {
        return JSON.parse(res.result_json);
      } catch {
        return res.result_json;
      }
    },

    async registerToken(token, taskId, role, agentConfigId) {
      await promisify(
        grpcClient,
        grpcClient.RegisterToken,
        {
          token,
          task_id: taskId,
          role,
          agent_config_id: agentConfigId,
        },
        emptyMeta()
      );
    },

    async handshake(token) {
      const handshakeCall = new Promise<string>((resolve, reject) => {
        let initialMeta: grpc.Metadata | undefined;

        const call = (grpcClient as any).Handshake(
          { token },
          emptyMeta(),
          (err: grpc.ServiceError | null, res: { ok: boolean; error: string }) => {
            if (err) {
              reject(err);
              return;
            }
            if (!res.ok) {
              reject(new Error(`Handshake failed: ${res.error}`));
              return;
            }
            const key = initialMeta?.get(SESSION_METADATA_KEY)?.[0];
            if (typeof key === "string" && key) {
              resolve(key);
            } else {
              reject(
                new Error(
                  "Handshake succeeded but no session key in response metadata"
                )
              );
            }
          }
        );

        call.on("metadata", (meta: grpc.Metadata) => {
          initialMeta = meta;
        });
      });
      sessionKey = await handshakeCall;
    },

    async revokeToken(token) {
      await promisify(
        grpcClient,
        grpcClient.RevokeToken,
        { token },
        emptyMeta()
      );
    },

    hasSession() {
      return !!sessionKey;
    },

    clearSession() {
      sessionKey = undefined;
    },

    close() {
      grpcClient.close();
    },
  };

  return client;
}
