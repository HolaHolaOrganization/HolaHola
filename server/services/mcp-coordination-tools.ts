/**
 * MCP (Model Context Protocol) tool definitions for HolaHola's coordination
 * ledger. This module is deliberately provider-neutral: it exposes the same
 * coordination operations Alden already uses as LLM tools
 * (server/services/alden-functions.ts) through the open MCP tool-calling
 * standard instead of a bespoke REST contract.
 *
 * Any MCP-speaking client — the Antigravity IDE, an OpenAI Agents/Responses
 * API remote-MCP connection, Claude, or a future platform — can attach to
 * the same server (see server/routes/mcp-coordination-route.ts) using a
 * given actor's own coordination token, and gets the same tools scoped to
 * that actor's own identity and authorization. Nothing in this file is
 * Antigravity-specific or platform-specific; the only per-connection state
 * is which coordination actor authenticated the request.
 *
 * Every handler below is a thin protocol translation over the existing
 * service layer (coordination-ledger-service.ts / coordination-inbox-
 * service.ts). Authorization (who may read or reply to which thread) is
 * enforced there, exactly as it is for every other coordination entry
 * point (REST routes, Alden's tool-calling loop, the CLI) — this module
 * does not duplicate or loosen it.
 */
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CoordinationActorId } from '@shared/schema';
import {
  appendCoordinationEvent,
  createCoordinationThread,
  getCoordinationThread,
  isCoordinationActorId,
} from './coordination-ledger-service';
import { listCoordinationInbox } from './coordination-inbox-service';

const PRIORITY = z.enum(['low', 'normal', 'high', 'urgent']);

const recipientSchema = z
  .string()
  .describe('Coordination actor id to address, e.g. "alden", "luca-replit", "daniela".')
  .refine(isCoordinationActorId, { message: 'Unknown coordination actor id' });

function textResult(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
}

function errorResult(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  const code = typeof (error as { code?: unknown })?.code === 'string' ? (error as { code: string }).code : undefined;
  return { ...textResult({ error: message, ...(code ? { code } : {}) }), isError: true as const };
}

/**
 * Everything the tool handlers need to know about the connection that
 * authenticated them. `canWrite` is resolved once, at connection time, by
 * the route (server/routes/mcp-coordination-route.ts) from the same
 * capability model every other coordination entry point uses — it is not
 * re-derived here so this module never has to know about legacy vs.
 * broker-issued credentials.
 */
export type CoordinationMcpAuthorization = {
  actor: CoordinationActorId;
  canWrite: boolean;
};

const WRITE_CAPABILITY_ERROR = "Credential lacks required capability: coordination:write";

/**
 * Registers the coordination toolset on `server`, scoped to `authorization`.
 * Create one McpServer (and call this once) per authenticated HTTP request
 * — see the stateless pattern in server/routes/mcp-coordination-route.ts —
 * so a connection can never act as any actor other than the one its own
 * token resolved to.
 */
export function registerCoordinationMcpTools(server: McpServer, authorization: CoordinationMcpAuthorization): void {
  const { actor, canWrite } = authorization;
  server.registerTool(
    'create_coordination_thread',
    {
      title: 'Create coordination thread',
      description: 'Open a new coordination thread addressed to another HolaHola actor.',
      inputSchema: {
        recipient: recipientSchema,
        title: z.string().min(1).max(300),
        description: z.string().min(1),
        model: z.string().min(1)
          .describe('Model/runtime identifier for attribution, e.g. "gemini-3-flash-preview".'),
        priority: PRIORITY.optional(),
      },
    },
    async ({ recipient, title, description, model, priority }) => {
      try {
        if (!canWrite) throw new Error(WRITE_CAPABILITY_ERROR);
        if (recipient === actor) {
          throw new Error('recipient cannot be yourself — address the thread to a different actor');
        }
        const result = await createCoordinationThread({
          actor,
          intendedRecipient: recipient as CoordinationActorId,
          title,
          description,
          priority,
          payload: { model },
          idempotencyKey: randomUUID(),
        });
        return textResult({
          threadId: result.thread.id,
          state: result.thread.state,
          sequence: result.thread.latestSequence,
          recipient,
          deliveryState: result.deliveryState,
        });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    'reply_to_coordination_thread',
    {
      title: 'Reply to coordination thread',
      description: 'Append a comment to an existing coordination thread you participate in.',
      inputSchema: {
        thread_id: z.string().min(1),
        recipient: recipientSchema,
        content: z.string().min(1),
        model: z.string().min(1).describe('Model/runtime identifier for attribution.'),
      },
    },
    async ({ thread_id, recipient, content, model }) => {
      try {
        if (!canWrite) throw new Error(WRITE_CAPABILITY_ERROR);
        if (recipient === actor) {
          throw new Error('recipient cannot be yourself — address the reply to a different actor');
        }
        const attempt = async () => {
          const { thread } = await getCoordinationThread(thread_id, actor);
          return appendCoordinationEvent({
            threadId: thread_id,
            actor,
            eventType: 'comment',
            content,
            recipientActor: recipient as CoordinationActorId,
            payload: { model },
            idempotencyKey: randomUUID(),
            expectedSequence: thread.latestSequence,
          });
        };
        let result;
        try {
          result = await attempt();
        } catch (error) {
          if ((error as { code?: string } | undefined)?.code === 'sequence_conflict') {
            result = await attempt(); // one retry against the freshly-read sequence
          } else {
            throw error;
          }
        }
        return textResult({
          threadId: result.thread.id,
          state: result.thread.state,
          sequence: result.thread.latestSequence,
          deliveryState: result.deliveryState,
        });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    'list_coordination_inbox',
    {
      title: 'List coordination inbox',
      description: 'List unread/paged coordination inbox items addressed to you.',
      inputSchema: {
        after: z.number().int().nonnegative().optional(),
        token: z.string().optional(),
        limit: z.number().int().positive().max(50).optional(),
      },
    },
    async ({ after, token, limit }) => {
      try {
        const result = await listCoordinationInbox(actor, { after, token, limit });
        return textResult({
          items: result.items.map((item: any) => ({
            threadId: item.thread.id,
            threadTitle: item.thread.title,
            eventType: item.event.eventType,
            from: item.event.actor,
            content: item.event.content,
            sequence: item.event.sequence,
            globalSequence: item.event.globalSequence,
            createdAt: item.event.createdAt,
          })),
          window: result.window,
        });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    'get_coordination_thread',
    {
      title: 'Get coordination thread',
      description: 'Read a coordination thread you participate in, including its full event history.',
      inputSchema: {
        thread_id: z.string().min(1),
        after_sequence: z.number().int().nonnegative().optional(),
      },
    },
    async ({ thread_id, after_sequence }) => {
      try {
        const { thread, events } = await getCoordinationThread(thread_id, actor, after_sequence);
        return textResult({
          threadId: thread.id,
          title: thread.title,
          description: thread.description,
          state: thread.state,
          originActor: thread.originActor,
          intendedRecipient: thread.intendedRecipient,
          priority: thread.priority,
          latestSequence: thread.latestSequence,
          events: events.map((event: any) => ({
            sequence: event.sequence,
            eventType: event.eventType,
            actor: event.actor,
            recipientActor: event.recipientActor,
            content: event.content,
            payload: event.payload,
            createdAt: event.createdAt,
          })),
        });
      } catch (error) {
        return errorResult(error);
      }
    },
  );
}

/**
 * The exact tool names this MCP server registers, recorded from the real
 * registration (never a hand-kept list), for orientation text and its tests.
 */
export function coordinationMcpToolNames(): string[] {
  const names: string[] = [];
  const recorder = { registerTool: (name: string) => { names.push(name); } };
  registerCoordinationMcpTools(recorder as unknown as McpServer, { actor: 'alden', canWrite: true } as CoordinationMcpAuthorization);
  return names;
}
