/**
 * Who you are to the other people in a room.
 *
 * Two separate things live here, both in localStorage:
 *
 *  - the **presence id**, which nothing displays and nobody edits. It only has
 *    to be stable enough that the room can tell two tabs apart.
 *  - the **display name**, which is the label over your cursor and the row in
 *    the collaborator list. It is yours to change, and it has to outlive a
 *    reload: it used to be regenerated on every mount, so the label over your
 *    cursor was a different animal each time the page loaded and nobody could
 *    learn who you were.
 *
 * Neither is `cd_device` — that cookie is board ownership, and reusing it here
 * would tie a name you can change to a claim you cannot.
 */
import { nanoid } from "nanoid";

export const USER_ID_KEY = "collabdraw_userId";
export const USER_NAME_KEY = "collabdraw_userName";

/**
 * Mirrors `MAX_TAG_LENGTH` in `server/src/validation.js`. The server clamps to
 * it regardless; matching here means the field stops you at the same place
 * rather than letting you type something that arrives truncated.
 */
export const MAX_USER_NAME_LENGTH = 64;

const ADJECTIVES = [
  "Happy",
  "Sunny",
  "Clever",
  "Swift",
  "Bright",
  "Creative",
  "Smart",
  "Quick",
  "Calm",
  "Friendly",
];

const NOUNS = [
  "Tiger",
  "Panda",
  "Eagle",
  "Fox",
  "Dolphin",
  "Wolf",
  "Bear",
  "Hawk",
  "Koala",
  "Owl",
];

const pick = (values: string[]): string =>
  values[Math.floor(Math.random() * values.length)];

/** A friendly default, so nobody has to name themselves before drawing. */
export const generateUserName = (): string => `${pick(ADJECTIVES)}${pick(NOUNS)}`;

/**
 * Collapse whitespace, trim, clamp. Returns `""` when nothing usable is left,
 * which callers treat as "keep the name you had" — a cursor with a blank label
 * is worse than one with an unedited name.
 */
export const normalizeUserName = (value: string): string =>
  value.replace(/\s+/g, " ").trim().slice(0, MAX_USER_NAME_LENGTH);

/** The stored presence id, minted and persisted on first use. */
export function readUserId(): string {
  try {
    const stored = window.localStorage.getItem(USER_ID_KEY);
    if (stored) {
      return stored;
    }
    const created = nanoid(8);
    window.localStorage.setItem(USER_ID_KEY, created);
    return created;
  } catch {
    // Private browsing or blocked storage: a per-session id is fine.
    return nanoid(8);
  }
}

/** The stored display name, generating and persisting one on first use. */
export function readUserName(): string {
  try {
    const stored = normalizeUserName(
      window.localStorage.getItem(USER_NAME_KEY) ?? "",
    );
    if (stored) {
      return stored;
    }
    const created = generateUserName();
    window.localStorage.setItem(USER_NAME_KEY, created);
    return created;
  } catch {
    return generateUserName();
  }
}

/**
 * Persist an edited name. Returns what was stored, or null when the input held
 * nothing usable — the caller keeps the previous name in that case.
 */
export function writeUserName(value: string): string | null {
  const name = normalizeUserName(value);
  if (!name) {
    return null;
  }
  try {
    window.localStorage.setItem(USER_NAME_KEY, name);
  } catch {
    // Blocked storage just means the choice does not outlive the session.
  }
  return name;
}
