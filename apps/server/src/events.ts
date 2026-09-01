import { EventEmitter } from "node:events";
import type { FastifyReply } from "fastify";

export interface AppEvent {
  type: string;
  at: string;
  data?: unknown;
}

export class EventBus {
  private readonly emitter = new EventEmitter();
  private readonly history: AppEvent[] = [];
  private static readonly HISTORY_LIMIT = 200;

  publish(type: string, data?: unknown): void {
    const event = {
      type,
      at: new Date().toISOString(),
      ...(data === undefined ? {} : { data })
    } satisfies AppEvent;
    this.history.push(event);
    if (this.history.length > EventBus.HISTORY_LIMIT) {
      this.history.splice(0, this.history.length - EventBus.HISTORY_LIMIT);
    }
    this.emitter.emit("event", event);
  }

  recent(limit = 100): AppEvent[] {
    const boundedLimit = Math.max(0, Math.min(EventBus.HISTORY_LIMIT, Math.trunc(limit)));
    return this.history.slice(-boundedLimit).reverse().map((event) => ({ ...event }));
  }

  attach(reply: FastifyReply): () => void {
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no"
    });
    reply.raw.write(`event: connected\ndata: ${JSON.stringify({ at: new Date().toISOString() })}\n\n`);

    const listener = (event: AppEvent): void => {
      reply.raw.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    };
    this.emitter.on("event", listener);
    const timer = setInterval(() => reply.raw.write(": keepalive\n\n"), 15_000);

    const detach = (): void => {
      clearInterval(timer);
      this.emitter.off("event", listener);
    };
    reply.raw.once("close", detach);
    return detach;
  }
}
