import { describe, expect, it } from "vitest";

import { sslForConnection } from "../db";

/**
 * The TLS decision is the difference between "it just works" and an opaque
 * handshake error, and it is made from a string a person pasted in, so it is
 * worth pinning down.
 */
describe("sslForConnection", () => {
  it("requires and verifies TLS for a managed host such as Neon", () => {
    expect(
      sslForConnection(
        "postgres://u:p@ep-cool-name-pooler.eu-central-1.aws.neon.tech/db?sslmode=require",
      ),
    ).toEqual({ rejectUnauthorized: true });
  });

  it("skips verification only when the string asks for it", () => {
    expect(
      sslForConnection("postgres://u:p@db.internal:5432/app?sslmode=no-verify"),
    ).toEqual({ rejectUnauthorized: false });
  });

  it("skips TLS for a local server, which usually has no certificate", () => {
    expect(sslForConnection("postgres://me@localhost:5432/collabdraw")).toBe(
      false,
    );
    expect(sslForConnection("postgres://me@127.0.0.1/collabdraw")).toBe(false);
    expect(sslForConnection("postgres://me@[::1]:5432/collabdraw")).toBe(false);
  });

  it("honours an explicit sslmode=disable on any host", () => {
    expect(
      sslForConnection("postgres://u:p@db.internal:5432/app?sslmode=disable"),
    ).toBe(false);
  });

  it("does not mistake a hostname that merely contains 'localhost'", () => {
    expect(
      sslForConnection("postgres://u:p@localhost.example.com/db"),
    ).toEqual({ rejectUnauthorized: true });
  });
});
