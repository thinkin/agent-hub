import { z } from 'zod';
import type { Agent } from '../config.js';

export const historyItem = z.object({ id: z.string().uuid(), cwd: z.string(), title: z.string(), modified: z.number(), created: z.number().optional() });
export const historyResult = z.object({ items: z.array(historyItem), total: z.number(), warnings: z.array(z.string()) });
export type HistoryResult = z.infer<typeof historyResult>;

export interface LaunchPlan {
  command: string;
  agentSessionId?: string;
  resolveSessionId?: (signal: AbortSignal) => Promise<string | undefined>;
}

export interface AgentAdapter {
  readonly type: Agent['type'];
  readonly label: string;
  readonly defaultExecutable: string;
  probe(agent: Agent): Promise<{ ok: true; message: string }>;
  history(agent: Agent, offset: number, limit: number, refresh?: boolean, sessionId?: string, sessionIds?: string[]): Promise<HistoryResult>;
  prepareLaunch(agent: Agent, cwd: string, sessionId?: string, picker?: boolean): Promise<LaunchPlan>;
  close(): void;
}
