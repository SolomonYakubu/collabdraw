/**
 * The only writer of the `cd_device` cookie, and therefore the root of anonymous
 * board ownership: `/boards` is a server component and cannot read a client-side
 * id, so this cookie is the one thing that can tell it which boards are yours.
 *
 * Two properties matter and neither is visible from the response body. A browser
 * has to keep the cookie — wrong `path` or a missing `maxAge` and ownership
 * resets on the next visit — and the *request* has to carry the same id onward,
 * because a first-ever visit to `/board/<id>` creates the board row in this same
 * pass. Response-only, that read came back empty and the board was stamped with
 * an owner no device could ever match.
 */
import { NextRequest, type NextResponse } from "next/server";
import { describe, expect, it, vi } from "vitest";

import { config, middleware } from "../middleware";

const DEVICE_COOKIE = "cd_device";

/** A page request, optionally already carrying a device cookie. */
const visit = (path = "/board/V1StGXR8_Z", cookie?: string) =>
  new NextRequest(`http://localhost${path}`, {
    headers: cookie === undefined ? {} : { cookie },
  });

/** The `Set-Cookie` the response would send, or undefined when it sends none. */
const setCookie = (response: NextResponse): string | undefined =>
  response.headers.getSetCookie()[0];

/** Its attributes, keyed lower-case; a flag such as `Secure` maps to "". */
const attributes = (header: string) =>
  new Map(
    header.split(";").map((part) => {
      const [key, ...rest] = part.trim().split("=");
      return [key.toLowerCase(), rest.join("=")];
    }),
  );

/** The id in the `Set-Cookie`. */
const issuedId = (response: NextResponse) =>
  attributes(setCookie(response) ?? "").get(DEVICE_COOKIE) ?? "";

describe("a visitor with no device id", () => {
  it("issues one", () => {
    const response = middleware(visit());

    expect(issuedId(response)).toMatch(/^[A-Za-z0-9_-]{12}$/);
  });

  it("hands the same id to the page rendering in this very pass", () => {
    // `x-middleware-request-cookie` is how `NextResponse.next({ request })`
    // carries the mutated request downstream, and it is what `cookies()` reads in
    // the server component that creates the board row. A second id here is the
    // unownable-board bug.
    const request = visit();

    const response = middleware(request);

    const id = issuedId(response);
    expect(request.cookies.get(DEVICE_COOKIE)?.value).toBe(id);
    expect(response.headers.get("x-middleware-request-cookie")).toBe(
      `${DEVICE_COOKIE}=${id}`,
    );
  });

  it("asks the browser to keep it for ten years, everywhere", () => {
    const written = attributes(setCookie(middleware(visit())) ?? "");

    expect(written.get("max-age")).toBe(String(60 * 60 * 24 * 365 * 10));
    expect(written.get("path")).toBe("/");
    expect(written.get("samesite")).toBe("lax");
  });

  it("leaves it readable by client code", () => {
    // Deliberate: the canvas needs to know which device it is. Nothing in the
    // browser writes it, which is what keeps ownership stable.
    expect(attributes(setCookie(middleware(visit())) ?? "").has("httponly")).toBe(
      false,
    );
  });

  it("marks it secure in production and not in development", () => {
    // `Secure` on a plain-http dev server is a cookie the browser drops, which
    // reads as a visitor who never keeps an id.
    expect(attributes(setCookie(middleware(visit())) ?? "").has("secure")).toBe(
      false,
    );

    vi.stubEnv("NODE_ENV", "production");
    try {
      expect(attributes(setCookie(middleware(visit())) ?? "").has("secure")).toBe(
        true,
      );
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("mints a fresh id per visitor", () => {
    // Two devices sharing an id would share a gallery.
    const ids = new Set(
      Array.from({ length: 50 }, () => issuedId(middleware(visit()))),
    );

    expect(ids.size).toBe(50);
  });

  it("keeps the id safe to put in a cookie header", () => {
    // base64 of 9 bytes, so no `=` padding to strip and no `+` or `/` to escape.
    for (let i = 0; i < 25; i += 1) {
      expect(issuedId(middleware(visit()))).not.toMatch(/[+/=]/);
    }
  });
});

describe("a visitor that already has one", () => {
  it("leaves it alone", () => {
    // Re-issuing on every request would hand the visitor a new identity — and a
    // new, empty gallery — on each page they open.
    const response = middleware(visit("/boards", `${DEVICE_COOKIE}=Q1O8kk53abcd`));

    expect(setCookie(response)).toBeUndefined();
  });

  it("replaces a cookie that exists but holds nothing", () => {
    // `cd_device=` reads back as a cookie that is present, and because this one is
    // not httpOnly a script on the origin can leave it that way. Treated as an id,
    // it strands the device: `getDeviceId()` returns "" and every board write
    // answers 400 forever.
    const response = middleware(visit("/boards", `${DEVICE_COOKIE}=`));

    expect(issuedId(response)).toMatch(/^[A-Za-z0-9_-]{12}$/);
  });

  it("keeps its own id even when other cookies are present", () => {
    const response = middleware(
      visit("/", `collabdraw_userId=u1; ${DEVICE_COOKIE}=Q1O8kk53abcd; theme=dark`),
    );

    expect(setCookie(response)).toBeUndefined();
  });
});

describe("what it runs for", () => {
  /**
   * The matcher as an anchored regex. Next compiles the pattern with
   * path-to-regexp, but the whole of this one is a hand-written negative
   * lookahead, so the intent can be checked directly — and it is worth checking,
   * because a matcher that catches `/api` would set a cookie header on every API
   * response, and one that catches static assets would run on every image.
   */
  const matches = (path: string) =>
    new RegExp(`^${config.matcher[0]}$`).test(path);

  it("runs on the pages that render a board or a gallery", () => {
    expect(matches("/")).toBe(true);
    expect(matches("/boards")).toBe(true);
    expect(matches("/board/V1StGXR8_Z")).toBe(true);
  });

  it("skips the API, Next's internals and anything with an extension", () => {
    expect(matches("/api/boards")).toBe(false);
    expect(matches("/_next/static/chunks/main.js")).toBe(false);
    expect(matches("/_next/image")).toBe(false);
    expect(matches("/favicon.ico")).toBe(false);
    expect(matches("/logo.svg")).toBe(false);
  });
});
