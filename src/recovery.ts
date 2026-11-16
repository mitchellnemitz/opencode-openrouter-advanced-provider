// ---------------------------------------------------------------------------
// Automatic recovery for invalid thought-signature errors on OpenRouter.
//
// OpenRouter routes multi-provider models (like Gemini) across different
// backing providers (Google AI Studio, Google Vertex AI, ...). When it
// fails over between providers mid-session, the new provider cannot
// validate the prior provider's encrypted reasoning signatures and returns
// HTTP 400 ("Invalid thought signature" / "Thought signature is not
// valid").
//
// Recovery: detect the error, strip signature fields from replayed
// reasoning parts, retry once. The strip is shape-agnostic — it removes
// any part property whose name ends in "signature" (the encrypted replay
// payloads), leaving the reasoning text, tool calls, and text content
// intact.
// ---------------------------------------------------------------------------

const THOUGHT_SIGNATURE_PATTERN = /invalid thought signature|thought signature.*not valid/i;

/** Detect failover signature errors. */
export function isThoughtSignatureError(text: string | undefined): boolean {
  return !!text && THOUGHT_SIGNATURE_PATTERN.test(text);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Remove reasoning replay signature data OpenRouter cannot validate after a
 * provider failover. Walks message part arrays and deletes every part
 * property whose name ends in "signature" (case-insensitive). Returns a new
 * array when something was stripped, else the original reference.
 */
export function stripReasoningSignatures<T>(messages: readonly T[]): T[] {
  let stripped = false;
  const next: unknown[] = messages.map((message) => {
    if (!isPlainObject(message)) return message;
    const parts =
      (message as Record<string, unknown>).parts ??
      (message as Record<string, unknown>).content;
    if (!Array.isArray(parts)) return message;
    let partStripped = false;
    const cleaned = parts.map((part) => {
      if (!isPlainObject(part)) return part;
      const out: Record<string, unknown> = { ...part };
      for (const key of Object.keys(part)) {
        if (/signature$/i.test(key)) {
          delete out[key];
          partStripped = true;
        }
      }
      return partStripped ? out : part;
    });
    if (partStripped) stripped = true;
    const key = Array.isArray((message as Record<string, unknown>).parts) ? "parts" : "content";
    return partStripped ? { ...message, [key]: cleaned } : message;
  });
  return stripped ? (next as T[]) : (messages as T[]);
}

/** Per-request retry bookkeeping: at most one signature retry per request. */
export interface RecoveryState {
  signatureRetried: boolean;
}

/** Decide whether a failed response deserves the one signature retry. */
export function planSignatureRetry(
  errorText: string | undefined,
  state: RecoveryState,
): boolean {
  if (!errorText) return false;
  if (!state.signatureRetried && isThoughtSignatureError(errorText)) {
    state.signatureRetried = true;
    return true;
  }
  return false;
}
