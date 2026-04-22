import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { LogosClient } from "../../agent/runtime/logosClient";
import { createLogosClient } from "../../agent/runtime/logosClient";

const CURRENT_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_PROTO_PATH = resolve(CURRENT_DIR, "../../../vfs/proto/logos.proto");

export interface SessionLifecycleClient {
  createSession(projectPath: string, sessionId: string): Promise<{ sessionId: string; workspacePath: string }>;
  checkpoint(sessionId: string, checkpointId: string): Promise<{ checkpointId: string }>;
  rollback(sessionId: string, checkpointId: string): Promise<void>;
  fork(fromSessionId: string, newSessionId: string): Promise<{ newSessionId: string }>;
}

export interface TuiLogosClient extends LogosClient {
  session: SessionLifecycleClient;
}

type GrpcCallback<T> = (error: grpc.ServiceError | null, response: T) => void;

function promisify<TReq, TRes>(
  client: any,
  method: Function,
  req: TReq,
  metadata: grpc.Metadata,
): Promise<TRes> {
  return new Promise((resolve, reject) => {
    method.call(client, req, metadata, (err: grpc.ServiceError | null, res: TRes) => {
      if (err) reject(err);
      else resolve(res);
    });
  });
}

export function createTuiLogosClient(socketPath: string): TuiLogosClient {
  const base = createLogosClient({ socketPath });

  const protoPath = DEFAULT_PROTO_PATH;
  const packageDefinition = protoLoader.loadSync(protoPath, {
    keepCase: true,
    longs: String,
    enums: String,
    defaults: true,
    oneofs: true,
  });
  const loaded = grpc.loadPackageDefinition(packageDefinition) as any;
  const LogosService = loaded.logos?.kernel?.v1?.Logos;
  const target = socketPath.startsWith("unix:") ? socketPath : `unix:${socketPath}`;
  const rawClient = new LogosService(target, grpc.credentials.createInsecure());
  const emptyMeta = () => new grpc.Metadata();

  const session: SessionLifecycleClient = {
    async createSession(projectPath, sessionId) {
      const res = await promisify<any, any>(
        rawClient, rawClient.CreateSession,
        { project_path: projectPath, session_id: sessionId },
        emptyMeta(),
      );
      return { sessionId: res.session_id, workspacePath: res.workspace_path };
    },

    async checkpoint(sessionId, checkpointId) {
      const res = await promisify<any, any>(
        rawClient, rawClient.Checkpoint,
        { session_id: sessionId, checkpoint_id: checkpointId },
        emptyMeta(),
      );
      return { checkpointId: res.checkpoint_id };
    },

    async rollback(sessionId, checkpointId) {
      await promisify<any, any>(
        rawClient, rawClient.Rollback,
        { session_id: sessionId, checkpoint_id: checkpointId },
        emptyMeta(),
      );
    },

    async fork(fromSessionId, newSessionId) {
      const res = await promisify<any, any>(
        rawClient, rawClient.Fork,
        { from_session_id: fromSessionId, new_session_id: newSessionId },
        emptyMeta(),
      );
      return { newSessionId: res.new_session_id };
    },
  };

  return Object.assign(base, { session }) as TuiLogosClient;
}
