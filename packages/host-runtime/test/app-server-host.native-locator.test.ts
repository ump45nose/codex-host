import { describe, expect, it, vi } from "vitest";
import { hostThreadIdSchema } from "@codexhost/shared-contracts";
import {
  stopFixture,
  completePiTurn,
  createFixture,
  startPiThread,
} from "./app-server-host-fixture.js";

describe("external session locator persistence", () => {
  it("persists locator changes for the same native identity and preserves turn mappings", async () => {
    const fixture = createFixture();
    try {
      const id = hostThreadIdSchema.parse(await startPiThread(fixture));
      await completePiTurn(fixture, id, 2);
      const before = await fixture.mappingStore.getThread(id);
      const session = fixture.adapter.sessions[0];
      if (!before?.nativeSessionRef || !session?.state.effectiveModel)
        throw new Error("Missing persisted fake Session");
      const nativeRef = {
        ...before.nativeSessionRef,
        locator: { cwd: "/synthetic", contextTier: "long_context" },
      };
      session.setStateForSnapshot({ ...session.state, nativeRef });
      const selected = await session.execute({
        type: "model.select",
        model: session.state.effectiveModel,
      });
      expect(selected.ok).toBe(true);
      await vi.waitFor(async () => {
        const after = await fixture.mappingStore.getThread(id);
        expect(after?.nativeSessionRef).toEqual(nativeRef);
        expect(after?.turnMappings).toEqual(before.turnMappings);
      });
    } finally {
      await stopFixture(fixture);
    }
  });
});
