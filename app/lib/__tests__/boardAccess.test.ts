import { describe, expect, it } from "vitest";

import {
  isUnclaimedOwner,
  isValidBoardId,
  mayWriteBoardMetadata,
  withinByteLimit,
} from "../boardAccess";

describe("isValidBoardId", () => {
  it("accepts nanoid-shaped ids", () => {
    expect(isValidBoardId("V1StGXR8_Z")).toBe(true);
    expect(isValidBoardId("abc-DEF_123")).toBe(true);
  });

  it("rejects an empty id", () => {
    expect(isValidBoardId("")).toBe(false);
  });

  it("rejects ids with path or query characters", () => {
    expect(isValidBoardId("../etc/passwd")).toBe(false);
    expect(isValidBoardId("abc def")).toBe(false);
    expect(isValidBoardId("abc?x=1")).toBe(false);
  });

  it("rejects an unbounded id that would bloat the primary key", () => {
    expect(isValidBoardId("a".repeat(65))).toBe(false);
  });

  it("rejects non-strings", () => {
    expect(isValidBoardId(undefined)).toBe(false);
    expect(isValidBoardId(42)).toBe(false);
  });
});

describe("withinByteLimit", () => {
  it("measures UTF-8 bytes, not characters", () => {
    // "€" is three bytes.
    expect(withinByteLimit("€", 3)).toBe(true);
    expect(withinByteLimit("€", 2)).toBe(false);
  });

  it("allows a payload exactly at the limit", () => {
    expect(withinByteLimit("abcd", 4)).toBe(true);
    expect(withinByteLimit("abcde", 4)).toBe(false);
  });
});

/**
 * The 403 these rules exist to prevent: a board created by the socket server
 * (owner "server") or by a cookie-less request could never be renamed or
 * deleted, because no device could match its owner.
 */
describe("board metadata ownership", () => {
  it("treats placeholder owners as unclaimed", () => {
    expect(isUnclaimedOwner("server")).toBe(true);
    expect(isUnclaimedOwner("anonymous")).toBe(true);
    expect(isUnclaimedOwner("")).toBe(true);
    expect(isUnclaimedOwner(null)).toBe(true);
    expect(isUnclaimedOwner("Q1O8kk53")).toBe(false);
  });

  it("lets the owner device write", () => {
    expect(mayWriteBoardMetadata("device-a", "device-a")).toBe(true);
  });

  it("refuses another device's board", () => {
    expect(mayWriteBoardMetadata("device-a", "device-b")).toBe(false);
  });

  it("lets any real device claim an unclaimed board", () => {
    expect(mayWriteBoardMetadata("server", "device-b")).toBe(true);
    expect(mayWriteBoardMetadata(null, "device-b")).toBe(true);
  });

  it("refuses a caller with no device id, claimed or not", () => {
    expect(mayWriteBoardMetadata("server", "")).toBe(false);
    expect(mayWriteBoardMetadata("device-a", "")).toBe(false);
  });
});
