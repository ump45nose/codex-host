const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

/**
 * Walks up React's fiber chain from a native element and returns the first value `pick` derives
 * from a component's props. Used where Codex keeps data in props but not in the DOM.
 */
export function findReactProps<T>(
  element: Element,
  pick: (props: Record<string, unknown>) => T | null | undefined,
  maxDepth = 16,
): T | null {
  const key = Object.getOwnPropertyNames(element).find((name) => name.startsWith("__reactFiber$"));
  let fiber: unknown = key ? (element as unknown as Record<string, unknown>)[key] : null;
  for (let depth = 0; isRecord(fiber) && depth < maxDepth; depth += 1) {
    const props = fiber.memoizedProps;
    if (isRecord(props)) {
      const picked = pick(props);
      if (picked !== null && picked !== undefined) return picked;
    }
    fiber = fiber.return;
  }
  return null;
}
