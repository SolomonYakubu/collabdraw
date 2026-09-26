/**
 * Copying text to the clipboard.
 *
 * `navigator.clipboard.writeText` is the modern path, but it refuses for reasons
 * a click cannot control: a document that is not focused yet, a permission the
 * browser has not granted, or a plain-HTTP origin. The first click after a page
 * loads (or after switching back to the tab) is exactly the case that trips on
 * the focus rule — the browser refuses once, the click focuses the window, and
 * the *next* click succeeds. That reads as "the copy button needs two clicks",
 * so the copy is attempted again through the selection-based fallback rather
 * than reported as failed on the first refusal.
 */

const legacyCopy = (text: string): boolean => {
  if (typeof document === "undefined") {
    return false;
  }

  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  // Off-screen rather than `display: none`: a hidden element cannot be
  // selected, and select() is what the fallback is built on.
  textarea.style.position = "fixed";
  textarea.style.top = "-9999px";
  textarea.style.opacity = "0";

  document.body.appendChild(textarea);
  try {
    textarea.select();
    textarea.setSelectionRange(0, textarea.value.length);
    return document.execCommand?.("copy") === true;
  } catch (error) {
    console.warn("Could not copy to the clipboard:", error);
    return false;
  } finally {
    document.body.removeChild(textarea);
  }
};

/** Copy text, returning whether it landed. Never throws. */
export const copyText = async (text: string): Promise<boolean> => {
  if (!text) {
    return false;
  }

  if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
    try {
      // Focusing first is not cosmetic: Chrome and Safari reject a clipboard
      // write while the document is not focused.
      window.focus();
      await navigator.clipboard.writeText(text);
      return true;
    } catch (error) {
      console.warn("Clipboard API refused the copy, trying the fallback:", error);
    }
  }

  return legacyCopy(text);
};
