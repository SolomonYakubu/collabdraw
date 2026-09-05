import { NextResponse, type NextRequest } from "next/server";

/**
 * Ensure every visitor has a stable `cd_device` cookie.
 *
 * The gallery at `/boards` is a server component and cannot read a client-side
 * id, so this cookie is the single server-readable source of truth for anonymous
 * board ownership. It is deliberately unrelated to `collabdraw_userId`, which is
 * the live collaboration presence id and changes meaning if it is reused here.
 *
 * `httpOnly` is false so client code can tell which device it is, but nothing
 * writes this cookie from the browser — one writer keeps ownership stable.
 */
const DEVICE_COOKIE = "cd_device";
const TEN_YEARS = 60 * 60 * 24 * 365 * 10;

/**
 * Web Crypto rather than `nanoid`: middleware runs in the Edge Runtime, and
 * keeping this file dependency-free avoids pulling a Node-targeted module into
 * the edge bundle (which broke `next build`).
 */
const createDeviceId = (): string => {
  const bytes = new Uint8Array(9);
  crypto.getRandomValues(bytes);
  // URL-safe base64, 12 chars — same entropy ballpark as nanoid(12).
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

export function middleware(request: NextRequest) {
  // The *value*, not just the cookie: `cd_device=` reads back as a cookie that
  // exists, and because this one is deliberately not httpOnly, any script on the
  // origin can leave it empty. Treating that as "already has an id" strands the
  // device — `getDeviceId()` returns "" and every board write answers 400 with no
  // way back — so an empty value is re-issued like a missing one.
  if (request.cookies.get(DEVICE_COOKIE)?.value) {
    return NextResponse.next();
  }

  const deviceId = createDeviceId();

  // Set it on the *request* as well, not just the response: a first-ever visit
  // to /board/<id> renders that page in this same pass, and it creates the board
  // row with whatever `cookies()` returns. Response-only, that read came back
  // empty and the board was stamped with an owner nobody could match.
  request.cookies.set(DEVICE_COOKIE, deviceId);
  const response = NextResponse.next({ request });

  response.cookies.set(DEVICE_COOKIE, deviceId, {
    httpOnly: false,
    sameSite: "lax",
    path: "/",
    maxAge: TEN_YEARS,
    secure: process.env.NODE_ENV === "production",
  });

  return response;
}

export const config = {
  // Page routes only — skip API, Next internals, and static assets.
  matcher: ["/((?!api|_next/static|_next/image|favicon.ico|.*\\.).*)"],
};
