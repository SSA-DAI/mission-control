import { getOpenClawClient } from './openclaw/client';
import type { PlanningQuestionPayload } from './types';

// Maximum input length for extractJSON to prevent ReDoS attacks
const MAX_EXTRACT_JSON_LENGTH = 1_000_000; // 1MB

/**
 * Extract JSON from a response that might have markdown code blocks or surrounding text.
 * Handles various formats:
 * - Direct JSON
 * - Markdown code blocks (```json ... ``` or ``` ... ```)
 * - JSON embedded in text (first { to last })
 */
export function extractJSON(text: string): object | null {
  // Security: Prevent ReDoS on massive inputs
  if (text.length > MAX_EXTRACT_JSON_LENGTH) {
    console.warn('[Planning Utils] Input exceeds maximum length for JSON extraction:', text.length);
    return null;
  }

  // First, try direct parse
  try {
    return JSON.parse(text.trim());
  } catch {
    // Continue to other methods
  }

  // Try to extract from markdown code block (```json ... ``` or ``` ... ```)
  // Use greedy match first (handles nested backticks), then lazy as fallback
  const codeBlockGreedy = text.match(/```(?:json)?\s*([\s\S]*)```/);
  if (codeBlockGreedy) {
    try {
      return JSON.parse(codeBlockGreedy[1].trim());
    } catch {
      // Continue
    }
  }
  const codeBlockLazy = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (codeBlockLazy) {
    try {
      return JSON.parse(codeBlockLazy[1].trim());
    } catch {
      // Continue
    }
  }
  // Handle unclosed code blocks (LLM generated opening ``` but no closing ```)
  const unclosedBlock = text.match(/```(?:json)?\s*(\{[\s\S]*)/);
  if (unclosedBlock) {
    const jsonCandidate = unclosedBlock[1].trim();
    try {
      return JSON.parse(jsonCandidate);
    } catch {
      // Try to find valid JSON by trimming from the end
      const lastBrace = jsonCandidate.lastIndexOf('}');
      if (lastBrace > 0) {
        try {
          return JSON.parse(jsonCandidate.slice(0, lastBrace + 1));
        } catch {
          // Continue
        }
      }
    }
  }

  // Try to find JSON object in the text (first { to last })
  const firstBrace = text.indexOf('{');
  const lastBrace = text.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    try {
      return JSON.parse(text.slice(firstBrace, lastBrace + 1));
    } catch {
      // Continue
    }
  }

  // KESULTANAN-FIX-001: balanced-brace scan. The first-{/last-} fallback above
  // fails when the agent appends prose AFTER a valid JSON object (trailing
  // garbage such as "… { ... } Terima kasih!" or a stray { … } in the text) —
  // the slice then spans past the closing brace and JSON.parse rejects it.
  // This scan walks the text once, tracking brace depth while respecting
  // strings and escapes, and returns the FIRST substring that (a) starts at
  // the first '{', (b) has balanced braces, and (c) parses as JSON.
  //
  // Deliberately NO auto-repair of truncated JSON: if the response is cut off
  // mid-string/mid-object the braces never balance and we return null, so the
  // caller stalls instead of silently dispatching corrupted data.
  //
  // ReDoS safety: single linear pass over the input (already capped at
  // MAX_EXTRACT_JSON_LENGTH); brace matching is O(n) with no backtracking.
  const balanced = findFirstBalancedJson(text);
  if (balanced) {
    return balanced;
  }

  return null;
}

/**
 * Single-pass balanced-brace scan (KESULTANAN-FIX-001).
 *
 * Finds the first '{', then walks forward tracking brace depth. Braces inside
 * quoted strings (with escape sequences) are ignored. When depth returns to 0
 * and the slice parses as JSON, that object is returned. If a balanced slice
 * fails to parse (e.g. stray prose between braces), scanning continues from
 * the next '{' rather than giving up.
 *
 * Returns null when no balanced, parseable JSON object exists — including
 * truncated responses (unbalanced braces).
 *
 * ReDoS safety: strictly ONE linear pass over the input (capped at
 * MAX_EXTRACT_JSON_LENGTH), no backtracking, no nested rescans. Each balanced
 * region is JSON.parse'd at most once and regions are disjoint, so total
 * parse work stays O(n).
 */
function findFirstBalancedJson(text: string): object | null {
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
    } else if (ch === '{') {
      if (depth === 0) {
        start = i; // new candidate object begins
      }
      depth++;
    } else if (ch === '}') {
      if (depth > 0) {
        depth--;
      }
      if (depth === 0 && start !== -1) {
        const candidate = text.slice(start, i + 1);
        try {
          return JSON.parse(candidate) as object;
        } catch {
          // Balanced but not valid JSON (stray braces/prose inside) — reset
          // and look for the next balanced object.
          start = -1;
        }
      }
    }
  }

  return null;
}

/**
 * KESULTANAN-FIX-001: parse a planning agent response and validate its shape.
 *
 * Runs {@link extractJSON} (direct parse → ```json fence → first-{/last-} →
 * balanced-brace scan) and then validates the result is a planning payload:
 * either a question (question + options) or a completion status. Anything
 * else — plain objects without those fields, non-object JSON, or unparseable
 * text — returns null so the auto-answer loop can stall with invalid_json
 * instead of mis-dispatching.
 *
 * This mirrors the tryParseQuestion driver behavior (docs/planning-driver.js):
 * accept JSON without a code fence, tolerate mixed/trailing prose, but never
 * auto-repair truncated JSON.
 */
export function parsePlanningPayload(text: string): PlanningQuestionPayload | null {
  const parsed = extractJSON(text);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;

  const record = parsed as Record<string, unknown>;
  const hasQuestion = typeof record.question === 'string' && Array.isArray(record.options);
  const hasStatus = typeof record.status === 'string';

  if (hasQuestion || hasStatus) {
    return parsed as PlanningQuestionPayload;
  }
  return null;
}

/**
 * Detect whether an assistant message content was truncated/invalid JSON.
 * Used to avoid silently stalling planning when a completion JSON was cut off.
 */
export function isTruncatedContent(content: string): boolean {
  if (!content) return false;
  if (content.includes('(truncated)')) return true;
  const trimmed = content.trimEnd();
  // fenced JSON without a closing fence
  if (trimmed.startsWith('```') && !trimmed.endsWith('```')) return true;
  // opened brace/object but no closing brace at all
  if (content.includes('{') && content.lastIndexOf('}') === -1) return true;
  return false;
}

/**
 * Get messages from OpenClaw API for a given session.
 * Returns assistant messages with text content extracted.
 */
export async function getMessagesFromOpenClaw(
  sessionKey: string
): Promise<Array<{ role: string; content: string }>> {
  try {
    const client = getOpenClawClient();
    if (!client.isConnected()) {
      await client.connect();
    }

    // Use chat.history API to get session messages
    const result = await client.call<{
      messages: Array<{
        role: string;
        content: Array<{ type: string; text?: string }>;
      }>;
    }>('chat.history', {
      sessionKey,
      limit: 50,
    });

    const messages: Array<{ role: string; content: string }> = [];

    for (const msg of result.messages || []) {
      if (msg.role === 'assistant') {
        const textContent = msg.content?.find((c) => c.type === 'text');
        if (textContent?.text && textContent.text.trim().length > 0) {
          messages.push({
            role: 'assistant',
            content: textContent.text,
          });
        }
      }
    }

    return messages;
  } catch (err) {
    console.error('[Planning Utils] Failed to get messages from OpenClaw:', err);
    return [];
  }
}
