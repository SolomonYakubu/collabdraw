/**
 * Sequence diagrams: participants over time.
 *
 * "Show me how X works" is usually a question about *order* — who calls whom, in
 * what sequence, and what comes back. Without this the model had to hand-build
 * one out of a free scene: lifelines placed by eye, arrows at guessed heights,
 * labels colliding. A sequence diagram is as structured as a grid, so the same
 * bargain applies — the model describes participants and ordered messages, and
 * the geometry is computed here.
 */
import { ACCENT_COLORS, type NodeAccent } from "./graph";

/** Solid for a call, dashed for what comes back, looped for self-calls. */
export type MessageKind = "call" | "return" | "self";

export const MESSAGE_KINDS: MessageKind[] = ["call", "return", "self"];

export interface SequenceParticipant {
  id: string;
  label: string;
  accent: NodeAccent;
}

export interface SequenceMessage {
  from: string;
  to: string;
  label: string;
  kind: MessageKind;
  /**
   * Starts a labelled section at this message, for the phases a sequence falls
   * into — "first attempt", "duplicate retry".
   */
  section: string;
}

export interface SequenceSpec {
  participants: SequenceParticipant[];
  messages: SequenceMessage[];
}

export const MAX_PARTICIPANTS = 8;
export const MAX_MESSAGES = 40;

const asAccent = (value: unknown): NodeAccent =>
  value && typeof value === "string" && value in ACCENT_COLORS
    ? (value as NodeAccent)
    : "none";

const trim = (value: unknown, limit: number): string =>
  typeof value === "string"
    ? value.replace(/\s+/g, " ").trim().slice(0, limit)
    : "";

const asKind = (value: unknown): MessageKind =>
  MESSAGE_KINDS.includes(value as MessageKind) ? (value as MessageKind) : "call";

/**
 * Validate a sequence description. Returns `null` when there is nothing usable,
 * so the caller can fall back to another intent.
 */
export const parseSequenceSpec = (input: unknown): SequenceSpec | null => {
  if (!input || typeof input !== "object") {
    return null;
  }

  const raw = input as Record<string, unknown>;
  const rawParticipants = Array.isArray(raw.participants) ? raw.participants : [];

  const participants: SequenceParticipant[] = [];
  const seen = new Set<string>();

  for (const candidate of rawParticipants) {
    if (participants.length >= MAX_PARTICIPANTS || !candidate) {
      continue;
    }

    const entry = candidate as Record<string, unknown>;
    const label = trim(entry.label, 28);
    const id = trim(entry.id, 40) || label;

    if (!id || seen.has(id)) {
      continue;
    }

    seen.add(id);
    participants.push({ id, label: label || id, accent: asAccent(entry.accent) });
  }

  // One participant cannot exchange anything; it is not a sequence.
  if (participants.length < 2) {
    return null;
  }

  const rawMessages = Array.isArray(raw.messages) ? raw.messages : [];
  const messages: SequenceMessage[] = [];

  for (const candidate of rawMessages) {
    if (messages.length >= MAX_MESSAGES || !candidate) {
      continue;
    }

    const entry = candidate as Record<string, unknown>;
    const from = trim(entry.from, 40);
    const to = trim(entry.to, 40);

    if (!seen.has(from) || !seen.has(to)) {
      continue;
    }

    // A message to oneself is a self-call however it was labelled.
    const kind = from === to ? "self" : asKind(entry.kind);

    messages.push({
      from,
      to,
      label: trim(entry.label, 60),
      kind,
      section: trim(entry.section, 40),
    });
  }

  return messages.length > 0 ? { participants, messages } : null;
};
