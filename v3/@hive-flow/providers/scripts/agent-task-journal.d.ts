export const TASK_JOURNAL_EVENTS: readonly string[];
export const TASK_JOURNAL_TERMINAL_EVENTS: readonly string[];

export interface TaskJournalEventInput {
  tasksDir: string;
  taskId: string;
  event: string;
  agentId?: string;
  provider?: string;
  model?: string;
  pid?: number;
  meta?: Record<string, unknown>;
}

export function classifyJournalError(err: unknown): 'auth' | 'rate' | 'quota' | 'overflow' | 'other';
export function redactEventMeta(meta: unknown): Record<string, string | number | boolean>;
export function normalizeTaskJournalEvent(input: unknown): Record<string, unknown> | null;
export function serializeTaskJournalEvent(input: unknown): string | null;
export function taskJournalPath(tasksDir: string, taskId: string): string;
export function appendTaskJournalEvent(input: TaskJournalEventInput): boolean;
export function replayTaskJournalEvents(linesOrEvents: string | Array<string | Record<string, unknown>>): {
  events: Record<string, unknown>[];
  monotonic: boolean;
  terminalCount: number;
  valid: boolean;
};
