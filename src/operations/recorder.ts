import { randomUUID } from "node:crypto";
import { errorMessage } from "../errors.js";
import { OperationLogStore, type OperationAction, type OperationRecord } from "./store.js";

type NewAction = OperationAction extends infer Action
  ? Action extends OperationAction
    ? Omit<Action, "id" | "status">
    : never
  : never;

export class OperationRecorder {
  readonly operationId = randomUUID();
  private readonly record: OperationRecord;

  constructor(private readonly store: OperationLogStore, command: string, environment: string) {
    const now = new Date().toISOString();
    this.record = { version: 1, id: this.operationId, command, environment, createdAt: now, updatedAt: now,
      status: "in-progress", actions: [] };
  }

  get hasActions(): boolean { return this.record.actions.length > 0; }

  async recordAction(action: NewAction): Promise<void> {
    if (!this.hasActions) await this.store.cleanup();
    this.record.actions.push({ ...action, id: randomUUID(), status: "applied" } as OperationAction);
    await this.persist();
  }

  async complete(): Promise<string | undefined> {
    if (!this.hasActions) return undefined;
    this.record.status = "completed";
    delete this.record.error;
    await this.persist();
    return this.operationId;
  }

  async fail(error: unknown): Promise<void> {
    if (!this.hasActions) return;
    this.record.status = "partial";
    this.record.error = errorMessage(error);
    await this.persist();
  }

  private async persist(): Promise<void> {
    this.record.updatedAt = new Date().toISOString();
    await this.store.save(this.record);
  }
}

export function withOperationId<T extends Record<string, unknown>>(value: T, operationId: string | undefined): T & { operationId?: string } {
  return operationId ? { ...value, operationId } : value;
}
