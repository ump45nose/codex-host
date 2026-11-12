import { mkdtempSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { JsonObject } from "@codexhost/protocol-core";

import {
  JsonLineCollector,
  completePiTurn,
  createFixture,
  requestId,
  startExternalThread,
  stopFixture,
  writeRequest,
} from "./app-server-host-fixture.js";

describe("External Thread paginated reopening", () => {
  it.each(["asc", "desc"] as const)(
    "hydrates every historical Item before and after switching Threads in %s order",
    async (sortDirection) => {
      const fixture = createFixture({
        mappingStoreDirectory: mkdtempSync(path.join(process.cwd(), ".w13-history-")),
      });
      const official = new JsonLineCollector(fixture.official.stdin);
      let nextId = 100;
      const request = async (method: string, params: JsonObject): Promise<JsonObject> => {
        const id = nextId++;
        writeRequest(fixture.desktopInput, { id, method, params });
        const response = await fixture.collector.waitFor((message) => requestId(message, id));
        expect(response, method).not.toHaveProperty("error");
        return response.result as JsonObject;
      };
      try {
        const threadId = await startExternalThread(fixture, "codexhost/pi-native", 1, {
          historyMode: "paginated",
        });
        const turnIds: string[] = [];
        for (const id of [10, 11, 12]) {
          turnIds.push(await completePiTurn(fixture, threadId, id));
        }
        const hydrate = async (): Promise<JsonObject[]> => {
          const resumed = await request("thread/resume", {
            threadId,
            excludeTurns: true,
            initialTurnsPage: { limit: 1, itemsView: "notLoaded", sortDirection },
          });
          expect(resumed.thread).toMatchObject({ id: threadId, turns: [] });
          expect(await request("thread/goal/get", { threadId })).toEqual({ goal: null });
          let page = resumed.initialTurnsPage as JsonObject;
          const loadedTurnIds: unknown[] = [];
          const loadedItems: JsonObject[] = [];
          for (let turnPage = 0; turnPage < turnIds.length; turnPage++) {
            const turns = page.data as JsonObject[];
            expect(turns).toHaveLength(1);
            for (const turn of turns) {
              expect(turn).toMatchObject({ items: [], itemsView: "notLoaded" });
              const turnId = turn.id;
              if (typeof turnId !== "string") throw new Error("History Turn has no ID");
              loadedTurnIds.push(turnId);
              let cursor: JsonObject | null = null;
              for (let itemPage = 0; itemPage < 3; itemPage++) {
                const items = await request("thread/items/list", {
                  threadId,
                  turnId,
                  sortDirection,
                  limit: 1,
                  cursor,
                });
                const entries = items.data as JsonObject[];
                loadedItems.push(...entries);
                if (items.nextCursor === null) {
                  cursor = null;
                  break;
                }
                const item = entries.at(-1)?.item as JsonObject;
                const itemId = item.id;
                if (typeof itemId !== "string") throw new Error("History Item has no ID");
                cursor = { type: "item", itemId };
              }
              expect(cursor, "Item pagination must terminate").toBeNull();
            }
            if (page.nextCursor === null) break;
            page = await request("thread/turns/list", {
              threadId,
              sortDirection,
              limit: 1,
              itemsView: "notLoaded",
              cursor: JSON.parse(page.nextCursor as string) as JsonObject,
            });
          }
          expect(page.nextCursor, "Turn pagination must terminate").toBeNull();
          expect(loadedTurnIds).toEqual(sortDirection === "asc" ? turnIds : turnIds.toReversed());
          expect(loadedItems).toHaveLength(6);
          expect(
            loadedItems
              .filter((entry) => (entry.item as JsonObject).type === "agentMessage")
              .map((entry) => (entry.item as JsonObject).text)
              .sort(),
          ).toEqual(["answer 10", "answer 11", "answer 12"]);
          expect(
            loadedItems.filter((entry) => (entry.item as JsonObject).type === "userMessage"),
          ).toHaveLength(3);
          return loadedItems;
        };

        const firstOpen = await hydrate();
        const otherId = await startExternalThread(fixture, "codexhost/pi-native", 2, {
          historyMode: "paginated",
        });
        await request("thread/resume", { threadId: otherId, excludeTurns: true });
        expect(await hydrate()).toEqual(firstOpen);
        expect(official.messages).toEqual([]);
      } finally {
        await stopFixture(fixture);
      }
    },
  );
});
