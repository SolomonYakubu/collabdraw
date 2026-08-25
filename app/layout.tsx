import type { Metadata, Viewport } from "next";
import { Geist } from "next/font/google";
import "./globals.css";
import { CollaborationContextProvider } from "./context/CollaborationContext";

const geist = Geist({
  variable: "--font-ui",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "CollabDraw",
  description: "Real-time collaborative whiteboard",
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
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </head>
      <body className={`${geist.variable} antialiased`}>
        <CollaborationContextProvider>{children}</CollaborationContextProvider>
      </body>
    </html>
  );
}
