import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { dirname, join } from "node:path";

export type TaskStatus = "pending" | "active" | "finished" | "sleep";

export interface SleepInfo {
  reason: "recoverable_error" | "awaiting_user";
  retry: boolean;
}

export interface Task {
  task_id: string;
  description: string;
  status: TaskStatus;
  workspace: string;
  chat_id?: string;
  created_at: string;
  updated_at: string;
  summary?: string;
  sleep?: SleepInfo;
  log_entries: string[];
}

export interface TaskStore {
  create(description: string, chatId?: string): Task;
  get(taskId: string): Task | undefined;
  activate(taskId: string): Task;
  finish(taskId: string, summary: string): Task;
  sleep(taskId: string, summary: string, sleepInfo: SleepInfo): Task;
  resume(taskId: string): Task;
  discard(taskId: string): void;
  appendLog(taskId: string, entry: string): void;
  listActive(): Task[];
  listSleeping(): Task[];
  listAll(): Task[];
  persist(): void;
}

export function createTaskStore(storePath?: string): TaskStore {
  const tasks = new Map<string, Task>();

  if (storePath) {
    try {
      const raw = readFileSync(storePath, "utf8");
      const loaded = JSON.parse(raw) as { tasks: Task[] };
      for (const t of loaded.tasks) {
        tasks.set(t.task_id, t);
      }
    } catch {
      // No existing store or parse error — start fresh.
    }
  }

  function requireTask(taskId: string): Task {
    const task = tasks.get(taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);
    return task;
  }

  function now(): string {
    return new Date().toISOString();
  }

  const store: TaskStore = {
    create(description, chatId) {
      const task: Task = {
        task_id: `task-${randomUUID().slice(0, 8)}`,
        description,
        status: "pending",
        workspace: "",
        chat_id: chatId,
        created_at: now(),
        updated_at: now(),
        log_entries: [],
      };
      task.workspace = `logos://sandbox/${task.task_id}`;
      tasks.set(task.task_id, task);
      return task;
    },

    get(taskId) {
      return tasks.get(taskId);
    },

    activate(taskId) {
      const task = requireTask(taskId);
      if (task.status !== "pending" && task.status !== "sleep") {
        throw new Error(
          `Cannot activate task ${taskId}: current status is ${task.status}`
        );
      }
      task.status = "active";
      task.sleep = undefined;
      task.updated_at = now();
      return task;
    },

    finish(taskId, summary) {
      const task = requireTask(taskId);
      if (task.status !== "active") {
        throw new Error(
          `Cannot finish task ${taskId}: current status is ${task.status}`
        );
      }
      task.status = "finished";
      task.summary = summary;
      task.updated_at = now();
      return task;
    },

    sleep(taskId, summary, sleepInfo) {
      const task = requireTask(taskId);
      if (task.status !== "active") {
        throw new Error(
          `Cannot sleep task ${taskId}: current status is ${task.status}`
        );
      }
      task.status = "sleep";
      task.summary = summary;
      task.sleep = sleepInfo;
      task.updated_at = now();
      return task;
    },

    resume(taskId) {
      const task = requireTask(taskId);
      if (task.status !== "sleep") {
        throw new Error(
          `Cannot resume task ${taskId}: current status is ${task.status}`
        );
      }
      task.status = "active";
      task.sleep = undefined;
      task.updated_at = now();
      return task;
    },

    discard(taskId) {
      tasks.delete(taskId);
    },

    appendLog(taskId, entry) {
      const task = requireTask(taskId);
      const timestamped = `[${now()}] ${entry}`;
      task.log_entries.push(timestamped);
    },

    listActive() {
      return [...tasks.values()].filter((t) => t.status === "active");
    },

    listSleeping() {
      return [...tasks.values()].filter((t) => t.status === "sleep");
    },

    listAll() {
      return [...tasks.values()];
    },

    persist() {
      if (!storePath) return;
      const data = { tasks: [...tasks.values()] };
      mkdirSync(dirname(storePath), { recursive: true });
      writeFileSync(storePath, JSON.stringify(data, null, 2), "utf8");
    },
  };

  return store;
}
