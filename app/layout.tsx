import type { Metadata, Viewport } from "next";
import { Geist } from "next/font/google";
import "./globals.css";

const geist = Geist({
  variable: "--font-ui",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  metadataBase: new URL(
    process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000",
  ),
  title: "CollabDraw",
  description: "Real-time collaborative whiteboard",
  openGraph: {
    title: "CollabDraw",
    description: "Real-time collaborative whiteboard",
    url: "/",
    siteName: "CollabDraw",
    type: "website",
    images: [
      {
        url: "/og-image.png",
        width: 1247,
        height: 583,
        alt: "CollabDraw — real-time collaborative whiteboard",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "CollabDraw",
    description: "Real-time collaborative whiteboard",
    images: ["/og-image.png"],
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  viewportFit: "cover",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#ffffff" },
    { media: "(prefers-color-scheme: dark)", color: "#121212" },
  ],
};

/**
 * Resolve the theme before first paint.
 *
 * Without this the page renders light, then flips once React's effect reads the
 * stored preference — a white flash on every load for anyone using dark mode.
 * It has to be inline and synchronous to land ahead of the first paint.
 */
const THEME_SCRIPT = `
(function () {
  try {
    var stored = localStorage.getItem("collabdraw_theme");
    var preference = stored === "light" || stored === "dark" ? stored : null;
    var theme =
      preference ||
      (window.matchMedia("(prefers-color-scheme: dark)").matches
        ? "dark"
        : "light");
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.colorScheme = theme;
  } catch (error) {
    document.documentElement.dataset.theme = "light";
  }
})();
`;

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    // The script above sets `data-theme` before hydration, which React would
    // otherwise flag as a mismatch.
    <html lang="en" suppressHydrationWarning>
      <head>
        <link
          rel="apple-touch-icon"
          sizes="180x180"
          href="/apple-touch-icon.png"
        />
        <link
          rel="icon"
          type="image/png"
          sizes="32x32"
          href="/favicon-32x32.png"
        />
        <link
          rel="icon"
          type="image/png"
          sizes="16x16"
          href="/favicon-16x16.png"
        />
        <link rel="manifest" href="/site.webmanifest"></link>
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </head>
      <body className={`${geist.variable} antialiased`}>
        {children}
      </body>
    </html>
  );
}
