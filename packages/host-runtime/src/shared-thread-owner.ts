import { randomUUID } from "node:crypto";
import { PassThrough } from "node:stream";
import {
  jsonRpcRequestSchema,
  parseJsonFrame,
  readLfFrames,
  writeJsonFrame,
  type JsonObject,
  type JsonRpcId,
} from "@codexhost/protocol-core";
import type { RemoteAppServerSession, RemoteAppServerSessionStreams } from "./remote-app-server.js";
import { object, rpcId, StreamThreadPeer, type SharedThreadPeer } from "./shared-thread-peer.js";

interface PendingSharedInteraction {
  id: string;
  nativeId: JsonRpcId;
  threadId: string | null;
  turnId: string | null;
  message: JsonObject;
  inFlight: boolean;
}

function interactionThreadId(params: JsonObject): string | null {
  return typeof params.threadId === "string"
    ? params.threadId
    : typeof params.conversationId === "string"
      ? params.conversationId
      : null;
}

/** One AppServerHost owns every external Session, independent of GUI connections. */
export class SharedThreadOwner {
  readonly input = new PassThrough();
  readonly output = new PassThrough();
  readonly #peer = new StreamThreadPeer(this.output, this.input, () => this.input.end());
  readonly #prefix = `shared-interaction:${randomUUID()}:`;
  readonly #interactions = new Map<string, PendingSharedInteraction>();
  readonly #clients = new Map<(message: JsonObject) => void, () => void>();
  #closed = false;
  readonly #receipts = new Map<string, { fingerprint: string; result: Promise<JsonObject> }>();

  constructor() {
    this.#peer.subscribe((message) => {
      let event = message;
      const params = object(message.params) ? message.params : {};
      if (rpcId(message.id)) {
        const id = `${this.#prefix}${message.id}`;
        event = { ...message, id };
        const existing = this.#interactions.get(id);
        if (existing) existing.message = event;
        else
          this.#interactions.set(id, {
            id,
            nativeId: message.id,
            threadId: interactionThreadId(params),
            turnId: typeof params.turnId === "string" ? params.turnId : null,
            message: event,
            inFlight: false,
          });
      } else if (message.method === "serverRequest/resolved" && rpcId(params.requestId)) {
        const id = `${this.#prefix}${params.requestId}`;
        if (!this.#interactions.delete(id)) return;
        event = { ...message, params: { ...params, requestId: id } };
      } else {
        const threadId = interactionThreadId(params);
        if (threadId) {
          if (["turn/completed", "turn/aborted", "turn/failed"].includes(String(message.method))) {
            const turnId =
              typeof params.turnId === "string"
                ? params.turnId
                : object(params.turn) && typeof params.turn.id === "string"
                  ? params.turn.id
                  : undefined;
            this.#forgetInteractions(threadId, turnId);
          } else if (message.method === "thread/archive" || message.method === "thread/archived") {
            this.#forgetInteractions(threadId);
          }
        }
      }
      this.#broadcast(event);
    });
    // Only the owner subscribes to this long-lived promise. Viewer close callbacks
    // live in the removable client registry, not in accumulating Promise reactions.
    void this.#peer.closed.then(() => this.close());
  }

  #broadcast(message: JsonObject): void {
    for (const listener of this.#clients.keys()) listener(message);
  }

  #forgetInteractions(threadId: string, turnId?: string): void {
    for (const pending of this.#interactions.values()) {
      if (
        pending.threadId === threadId &&
        (turnId === undefined || pending.turnId === null || pending.turnId === turnId)
      ) {
        this.#interactions.delete(pending.id);
      }
    }
  }

  #request(method: string, params: JsonObject): Promise<JsonObject> {
    const key =
      method === "turn/start" && typeof params.clientUserMessageId === "string"
        ? `${params.threadId}\u0000${params.clientUserMessageId}`
        : null;
    if (!key)
      return this.#peer.request(method, params).then((reply) => {
        if (!reply.error && method === "thread/archive" && typeof params.threadId === "string") {
          this.#forgetInteractions(params.threadId);
        }
        return reply;
      });
    const fingerprint = JSON.stringify(params);
    const existing = this.#receipts.get(key);
    if (existing)
      return existing.fingerprint === fingerprint
        ? existing.result
        : Promise.resolve({
            error: { code: -32602, message: "Message ID was already used with different input" },
          });
    const result = this.#peer.request(method, params);
    this.#receipts.set(key, { fingerprint, result });
    void result.then(
      (reply) => {
        if (reply.error) this.#receipts.delete(key);
        while (this.#receipts.size > 256) {
          const oldest = this.#receipts.keys().next().value;
          if (oldest === undefined) break;
          this.#receipts.delete(oldest);
        }
      },
      () => this.#receipts.delete(key),
    );
    return result;
  }

  connect(): SharedThreadPeer {
    const ended = Promise.withResolvers<undefined>();
    const listeners = new Set<(message: JsonObject) => void>();
    const replayDeliveries = new Set<Set<string>>();
    let closed = false;
    const publish = (message: JsonObject, live = true): void => {
      if (live && typeof message.id === "string") {
        for (const delivered of replayDeliveries) delivered.add(message.id);
      }
      for (const listener of listeners) {
        try {
          listener(message);
        } catch {
          peer.close();
        }
      }
    };
    const peer: SharedThreadPeer = {
      closed: ended.promise,
      request: async (method, params) => {
        if (closed) throw new Error("Shared Thread client is closed");
        if (method !== "thread/resume" || typeof params.threadId !== "string") {
          return this.#request(method, params);
        }
        // Include live frames queued downstream while the resume is still pending.
        const delivered = new Set<string>();
        replayDeliveries.add(delivered);
        const reply = await this.#request(method, params).catch((error: unknown) => {
          replayDeliveries.delete(delivered);
          throw error;
        });
        if (reply.error) replayDeliveries.delete(delivered);
        else {
          // Response consumers enqueue their JSON-RPC reply before the next event-loop frame.
          setImmediate(() => {
            replayDeliveries.delete(delivered);
            if (closed) return;
            for (const pending of this.#interactions.values()) {
              if (
                pending.threadId === params.threadId &&
                !pending.inFlight &&
                !delivered.has(pending.id)
              ) {
                publish(pending.message, false);
              }
            }
          });
        }
        return reply;
      },
      respond: async (message) => {
        if (closed || typeof message.id !== "string") return;
        const pending = this.#interactions.get(message.id);
        if (!pending || pending.inFlight) return;
        pending.inFlight = true;
        await this.#peer.respond({ ...message, id: pending.nativeId });
        if (this.#interactions.get(pending.id) !== pending) return;
        this.#interactions.delete(pending.id);
        this.#broadcast({
          method: "serverRequest/resolved",
          params: {
            requestId: pending.id,
            ...(pending.threadId === null ? {} : { threadId: pending.threadId }),
          },
        });
      },
      subscribe: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      close: () => {
        if (closed) return;
        closed = true;
        this.#clients.delete(publish);
        listeners.clear();
        replayDeliveries.clear();
        ended.resolve(undefined);
      },
    };
    this.#clients.set(publish, peer.close);
    if (this.#closed) peer.close();
    return peer;
  }

  /** Socket disconnect detaches a viewer; it never closes the owner or cancels work. */
  createSession(streams: RemoteAppServerSessionStreams): RemoteAppServerSession {
    const peer = this.connect();
    let detached = false;
    const send = (message: JsonObject): void => {
      if (detached || streams.output.destroyed) return;
      // Detach if the session's output stream stops draining.
      if (streams.output.writableLength > 8 * 1024 * 1024) {
        peer.close();
        streams.input.destroy();
        return;
      }
      void writeJsonFrame(streams.output, message).catch(() => peer.close());
    };
    const unsubscribe = peer.subscribe(send);
    return {
      run: async () => {
        try {
          for await (const frame of readLfFrames(streams.input, {
            maxFrameBytes: 128 * 1024 * 1024,
          })) {
            const message = parseJsonFrame(frame);
            const parsed = jsonRpcRequestSchema.safeParse(message);
            if (parsed.success) {
              const request = parsed.data;
              void peer.request(request.method, object(request.params) ? request.params : {}).then(
                (reply) => send({ ...reply, id: request.id }),
                () =>
                  send({
                    id: request.id,
                    error: {
                      code: -32090,
                      message: "Shared Thread Host disconnected; outcome may be unknown",
                    },
                  }),
              );
            } else if (object(message) && rpcId(message.id)) {
              await peer.respond(message);
            }
          }
          return 0;
        } finally {
          detached = true;
          unsubscribe();
          peer.close();
        }
      },
      disconnect: () => {
        detached = true;
        streams.input.destroy();
      },
      close: () => {
        detached = true;
        peer.close();
        streams.input.destroy();
      },
    };
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#peer.close();
    for (const close of this.#clients.values()) close();
    this.#receipts.clear();
    this.#interactions.clear();
  }
}
