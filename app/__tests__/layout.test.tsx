// @vitest-environment jsdom
/**
 * The root layout, and the theme script it inlines.
 *
 * Almost all of this file is markup, and the one piece that is not is the piece
 * with no other test: `THEME_SCRIPT` is a template literal, so nothing compiles
 * it, nothing type-checks it and nothing lints it. It runs before the first paint
 * because the alternative is a white flash on every load for anyone in dark mode —
 * React's effect reads the stored preference too late — and a typo in it is
 * invisible until that flash comes back. So the tests here run the string.
 *
 * Its whitelist is the subtle part. `useTheme` stores three values and this script
 * accepts two: "system" has to fall through to the media query rather than be
 * written to `data-theme`, which no stylesheet matches.
 *
 * The rest is what the markup promises the rest of the app: the CSS variable every
 * font rule resolves against, an absolute `metadataBase` so link previews are not
 * relative to nothing, icon hrefs that exist, and `suppressHydrationWarning` on
 * the element this very script mutates.
 */
import { readFileSync } from "node:fs";

import { Children, isValidElement, type ReactElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** `next/font` reaches the network at module load and returns generated names. */
const font = vi.hoisted(() => ({ options: [] as Record<string, unknown>[] }));

vi.mock("next/font/google", () => ({
  Geist: (options: Record<string, unknown>) => {
    font.options.push(options);
    return { variable: "font-generated", className: "font-generated" };
  },
}));

/*
 * The layout imports the stylesheet, which would take Vite's CSS pipeline —
 * and with it Tailwind's PostCSS plugin, which Vite cannot load — through a file
 * this test has nothing to say about.
 */
vi.mock("../globals.css", () => ({}));

import RootLayout, { metadata, viewport } from "../layout";

/** The layout is static markup, so its tree can be walked without a DOM. */
const walk = (node: ReactNode, found: ReactElement[] = []): ReactElement[] => {
  Children.forEach(node, (child) => {
    if (!isValidElement(child)) {
      return;
    }
    found.push(child);
    walk((child.props as { children?: ReactNode }).children, found);
  });
  return found;
};

const html = () =>
  RootLayout({ children: <main data-testid="page" /> }) as ReactElement;

const tagged = (type: string) => walk(html()).filter((el) => el.type === type);

const props = (el: ReactElement) => el.props as Record<string, string>;

/** The inline script's source, as the browser would receive it. */
const themeScript = () =>
  (
    props(tagged("script")[0]) as unknown as {
      dangerouslySetInnerHTML: { __html: string };
    }
  ).dangerouslySetInnerHTML.__html;

/** Run it the way the browser does: synchronously, against this document. */
const runBeforePaint = () => new Function(themeScript())();

const theme = () => document.documentElement.dataset.theme;
const colorScheme = () => document.documentElement.style.colorScheme;

const realMatchMedia = window.matchMedia;

/** What the OS asks for, which jsdom otherwise always answers "light" to. */
const osPrefersDark = (matches: boolean) => {
  window.matchMedia = ((media: string) => ({
    matches,
    media,
  })) as unknown as typeof window.matchMedia;
};

beforeEach(() => {
  localStorage.clear();
  delete document.documentElement.dataset.theme;
  document.documentElement.style.colorScheme = "";
  osPrefersDark(false);
});

afterEach(() => {
  window.matchMedia = realMatchMedia;
  vi.restoreAllMocks();
});

describe("resolving the theme before the first paint", () => {
  it("uses the stored preference, so a dark board never flashes white", () => {
    // The whole reason the script exists: React's effect runs after paint.
    localStorage.setItem("collabdraw_theme", "dark");

    runBeforePaint();

    expect(theme()).toBe("dark");
    expect(colorScheme()).toBe("dark");
  });

  it("prefers it over the operating system's", () => {
    // Choosing light on a dark machine is a choice, and this is where it is kept.
    localStorage.setItem("collabdraw_theme", "light");
    osPrefersDark(true);

    runBeforePaint();

    expect(theme()).toBe("light");
    expect(colorScheme()).toBe("light");
  });

  it("falls back to the operating system when nothing has been chosen", () => {
    osPrefersDark(true);

    runBeforePaint();

    expect(theme()).toBe("dark");
  });

  it("resolves \"system\" rather than writing it out", () => {
    /*
     * `useTheme` stores three values — light, dark and system — under this same
     * key. Only two of them are themes: `data-theme="system"` matches no
     * stylesheet, so the page would render with no theme at all until React
     * caught up. Hence the whitelist rather than a straight read.
     */
    localStorage.setItem("collabdraw_theme", "system");
    osPrefersDark(true);

    runBeforePaint();

    expect(theme()).toBe("dark");
  });

  it("ignores a value that means nothing at all", () => {
    localStorage.setItem("collabdraw_theme", "aubergine");

    runBeforePaint();

    expect(theme()).toBe("light");
  });

  it("still picks a theme where storage is blocked", () => {
    /*
     * Reading `localStorage` throws outright in a locked-down browser — Safari
     * with cookies and site data disabled. Unhandled, the exception would take
     * the inline script with it and leave the document with no `data-theme`.
     */
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("The operation is insecure.");
    });

    runBeforePaint();

    expect(theme()).toBe("light");
  });

  it("reads the key useTheme writes", () => {
    // Two ends of one preference in two files; drift here brings the flash back
    // silently, since both halves keep working on their own.
    expect(themeScript()).toContain('localStorage.getItem("collabdraw_theme")');
  });
});

describe("the document it wraps every page in", () => {
  it("expects the script to have changed the html element already", () => {
    // The script above sets `data-theme` on this element before hydration, which
    // React compares against what the server sent and reports as a mismatch.
    // Without the flag, every load logs one in development.
    expect(props(html()).lang).toBe("en");
    expect(props(html()).suppressHydrationWarning).toBe(true);
  });

  it("puts the font's class on the body, where the CSS variable is needed", () => {
    // `--font-ui` is the name every font rule in `globals.css` resolves against,
    // and it only exists on the element carrying the generated class.
    expect(font.options[0].variable).toBe("--font-ui");
    expect(props(tagged("body")[0]).className).toContain("font-generated");
    expect(props(tagged("body")[0]).className).toContain("antialiased");
  });

  it("renders the page inside the body", () => {
    expect(walk(tagged("body")[0]).map((el) => props(el)["data-testid"])).toContain(
      "page",
    );
  });

  it("points its icons and manifest at files that exist", () => {
    // A rename in `public/` is otherwise a 404 nobody sees until a phone shows a
    // blank home-screen tile.
    const hrefs = tagged("link").map((el) => props(el).href);

    expect(hrefs).toContain("/site.webmanifest");
    for (const href of hrefs) {
      expect(() => readFileSync(`public${href}`)).not.toThrow();
    }
  });
});

describe("what a link to the app previews as", () => {
  it("declares the preview image at the size the file actually is", () => {
    /*
     * Scrapers lay out the card from these numbers and fetch the image
     * separately; a width that no longer matches the file crops or letterboxes
     * the preview, and nothing in the app ever renders it to give that away.
     */
    const image = metadata.openGraph!.images as { url: string; width: number; height: number }[];
    const png = readFileSync(`public${image[0].url}`);

    expect(png.readUInt32BE(16)).toBe(image[0].width);
    expect(png.readUInt32BE(20)).toBe(image[0].height);
  });

  it("makes that image's URL absolute, since a preview is fetched elsewhere", () => {
    // Relative to nothing, `/og-image.png` is unfetchable by the scraper. The
    // fallback is localhost, which is right for a developer and wrong in a
    // deployment — hence the environment variable.
    expect(metadata.metadataBase?.href).toBe("http://localhost:3000/");
  });

  it("takes the deployed origin from the environment", async () => {
    // Read once, when the module loads, so this needs its own import.
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://collabdraw.example");
    vi.resetModules();

    const deployed = await import("../layout");

    expect(deployed.metadata.metadataBase?.href).toBe("https://collabdraw.example/");
    vi.unstubAllEnvs();
  });
});

describe("how it sits on a phone", () => {
  it("refuses the browser's own zoom, the canvas having its own", () => {
    /*
     * A drawing app pinches to zoom the drawing. Left scalable, the same gesture
     * scales the page — the toolbar and the canvas together — and the two
     * behaviours fight over every pinch.
     */
    expect(viewport.maximumScale).toBe(1);
    expect(viewport.userScalable).toBe(false);
  });

  it("draws under the notch, the canvas being the whole screen", () => {
    expect(viewport.viewportFit).toBe("cover");
  });

  it("tints the browser chrome for both themes the script can resolve", () => {
    // The pair matches the script's two outcomes; one entry would leave the other
    // theme with a mismatched status bar.
    expect(viewport.themeColor).toEqual([
      { media: "(prefers-color-scheme: light)", color: "#ffffff" },
      { media: "(prefers-color-scheme: dark)", color: "#121212" },
    ]);
  });
});
