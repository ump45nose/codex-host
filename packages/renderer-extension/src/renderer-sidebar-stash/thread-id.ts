/** Stable thread ids only. Titles are display text and are never accepted. */

export type ThreadIdErrorCode = "invalid" | "looks-like-title" | "not-persisted";

export class ThreadIdError extends Error {
  readonly code: ThreadIdErrorCode;
  constructor(code: ThreadIdErrorCode, message: string) {
    super(message);
    this.name = "ThreadIdError";
    this.code = code;
  }
}

const TEMPORARY = /client-new-thread/i;

export function canonicalThreadId(input: unknown): string {
  if (typeof input !== "string") {
    throw new ThreadIdError("invalid", "thread id must be a string");
  }
  let value = input.trim();
  if (!value) throw new ThreadIdError("invalid", "thread id is empty");
  if (/^local:/i.test(value)) value = value.slice(value.indexOf(":") + 1).trim();
  if (!value) throw new ThreadIdError("invalid", "thread id is empty");
  if (/\s/.test(value)) {
    throw new ThreadIdError("looks-like-title", "thread id must not be inferred from a title");
  }
  if (TEMPORARY.test(value)) {
    throw new ThreadIdError("not-persisted", "thread does not have a stable id yet");
  }
  if (value.length < 8 || value.length > 200) {
    throw new ThreadIdError("invalid", "thread id length is not plausible");
  }
  if (!/^[A-Za-z0-9:._~-]+$/.test(value)) {
    throw new ThreadIdError("invalid", "thread id has unexpected characters");
  }
  return value;
}
