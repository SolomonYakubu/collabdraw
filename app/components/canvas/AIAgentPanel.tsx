"use client";

/**
 * The assistant panel.
 *
 * Deliberately quiet: no gradients, no glow, no bubble-per-message, no uppercase
 * "AGENT" tags. It is a panel like the toolbar and the properties panel, built
 * from the same tokens so it themes with them. Replies read as text on the page;
 * only the user's own messages get a tint, which is enough to tell the two apart.
 */
import { memo, useEffect, useMemo, useRef } from "react";
import { FiCornerDownLeft, FiTrash2, FiX } from "react-icons/fi";

interface AIChatHistoryEntry {
  role: "user" | "model";
  parts: Array<{ text: string }>;
  /** Sent to the model but kept out of the transcript (an automatic turn). */
  hidden?: boolean;
}

interface AIAgentPanelProps {
  isOpen: boolean;
  prompt: string;
  history: AIChatHistoryEntry[];
  isGenerating: boolean;
  error: string | null;
  /** When on, the assistant takes its own turn after each edit to the canvas. */
  autoRespond: boolean;
  onToggleAutoRespond: (autoRespond: boolean) => void;
  /**
   * When on, requests bias towards the system design kind — typed components,
   * tiered layout.
   */
  architectureMode: boolean;
  onToggleArchitectureMode: (architectureMode: boolean) => void;
  onPromptChange: (prompt: string) => void;
  onSend: () => void;
  onDismissError: () => void;
  onClose: () => void;
  onResetConversation: () => void;
}

const SUGGESTIONS = [
  "a flowchart for handling a support ticket",
  "design a URL shortener",
  "a tic-tac-toe board",
  "a pendulum with its forces labelled",
];

function AIAgentPanel({
  isOpen,
  prompt,
  history,
  isGenerating,
  error,
  autoRespond,
  onToggleAutoRespond,
  architectureMode,
  onToggleArchitectureMode,
  onPromptChange,
  onSend,
  onDismissError,
  onClose,
  onResetConversation,
}: AIAgentPanelProps) {
  const endRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);

  const messages = useMemo(
    () =>
      history
        // Automatic turns are sent to the model but never shown: a column of
        // "your turn" prompts is noise the user did not write.
        .filter((entry) => !entry.hidden)
        .map((entry, index) => ({
          id: `${entry.role}-${index}`,
          role: entry.role,
          text: entry.parts[0]?.text ?? "",
        })),
    [history],
  );

  useEffect(() => {
    if (isOpen) {
      endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
    }
  }, [messages, isGenerating, isOpen, error]);

  useEffect(() => {
    if (isOpen) {
      inputRef.current?.focus();
    }
  }, [isOpen]);

  if (!isOpen) {
    return null;
  }

  return (
    <>
      {/* Mobile backdrop */}
      <div
        className="fixed inset-0 z-40 bg-black/30 backdrop-blur-xs md:hidden"
        onClick={onClose}
        aria-hidden="true"
      />

      <aside
        className="island animate-slide-up pointer-events-auto fixed inset-x-2 bottom-2 top-auto z-40 flex max-h-[85vh] flex-col overflow-hidden shadow-2xl md:absolute md:inset-auto md:right-3 md:top-3 md:max-h-[calc(100%-1.5rem)] md:w-[22rem]"
        aria-label="Assistant"
        style={{ marginBottom: "max(0.5rem, env(safe-area-inset-bottom, 0.5rem))" }}
      >
        <header
          className="flex items-center gap-2 border-b px-3 py-2"
          style={{ borderColor: "var(--divider)" }}
        >
        <h2 className="text-[13px] font-semibold">Assistant</h2>
        <span className="text-[11px]" style={{ color: "var(--text-faint)" }}>
          sees your canvas
        </span>

        <div className="ml-auto flex items-center gap-1">
          <button
            type="button"
            role="switch"
            aria-checked={autoRespond}
            onClick={() => onToggleAutoRespond(!autoRespond)}
            title={
              autoRespond
                ? "Live is on: the assistant replies on its own after each move. Click to turn off."
                : "Live is off: turn on to let the assistant reply on its own after each move."
            }
            aria-label="Live: reply automatically after each move"
            className="flex items-center gap-1.5 rounded-full px-2 py-1 text-[11px] font-medium transition-colors"
            style={{
              background: autoRespond ? "var(--accent)" : "var(--hover-bg)",
              color: autoRespond
                ? "var(--accent-contrast)"
                : "var(--text-muted)",
            }}
          >
            <span
              className="h-1.5 w-1.5 rounded-full"
              style={{
                background: autoRespond
                  ? "var(--accent-contrast)"
                  : "var(--text-faint)",
              }}
            />
            Live
          </button>

          <button
            type="button"
            role="switch"
            aria-checked={architectureMode}
            onClick={() => onToggleArchitectureMode(!architectureMode)}
            title={
              architectureMode
                ? "Architecture mode is on: requests bias towards system designs with typed components. Click to turn off."
                : "Architecture mode is off. Turn on to bias requests towards system designs with typed components."
            }
            aria-label="Architecture mode: bias towards system design drawings"
            className="flex items-center gap-1.5 rounded-full px-2 py-1 text-[11px] font-medium transition-colors"
            style={{
              background: architectureMode
                ? "var(--accent)"
                : "var(--hover-bg)",
              color: architectureMode
                ? "var(--accent-contrast)"
                : "var(--text-muted)",
            }}
          >
            <span
              className="h-1.5 w-1.5 rounded-full"
              style={{
                background: architectureMode
                  ? "var(--accent-contrast)"
                  : "var(--text-faint)",
              }}
            />
            Arch
          </button>

          {messages.length > 0 && (
            <button
              type="button"
              className="island-button h-7 w-7"
              onClick={onResetConversation}
              title="Clear the conversation"
              aria-label="Clear the conversation"
            >
              <FiTrash2 size={13} />
            </button>
          )}
          <button
            type="button"
            className="island-button h-7 w-7"
            onClick={onClose}
            title="Close"
            aria-label="Close the assistant"
          >
            <FiX size={15} />
          </button>
        </div>
      </header>

      <div className="thin-scroll flex-1 overflow-y-auto px-3 py-3">
        {messages.length === 0 ? (
          <div className="flex flex-col gap-3">
            <p
              className="text-[13px] leading-relaxed"
              style={{ color: "var(--text-muted)" }}
            >
              Describe what to draw, or ask for a change to what is already here.
            </p>
            <div className="flex flex-col items-start gap-1.5">
              {SUGGESTIONS.map((suggestion) => (
                <button
                  key={suggestion}
                  type="button"
                  onClick={() => {
                    onPromptChange(suggestion);
                    inputRef.current?.focus();
                  }}
                  className="rounded-md px-2 py-1 text-left text-[12px] transition-colors"
                  style={{
                    color: "var(--accent)",
                    background: "var(--hover-bg)",
                  }}
                >
                  {suggestion}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            {messages.map((message) =>
              message.role === "user" ? (
                <p
                  key={message.id}
                  className="self-end rounded-lg rounded-br-sm px-2.5 py-1.5 text-[13px] leading-relaxed"
                  style={{
                    maxWidth: "85%",
                    background: "var(--hover-bg)",
                    color: "var(--text)",
                  }}
                >
                  {message.text}
                </p>
              ) : (
                <p
                  key={message.id}
                  className="text-[13px] leading-relaxed"
                  style={{ color: "var(--text-muted)" }}
                >
                  {message.text}
                </p>
              ),
            )}

            {isGenerating && (
              <p
                className="flex items-center gap-2 text-[13px]"
                style={{ color: "var(--text-faint)" }}
              >
                <span
                  className="h-3 w-3 animate-spin rounded-full border-2 border-current"
                  style={{ borderTopColor: "transparent" }}
                />
                Drawing…
              </p>
            )}

            <div ref={endRef} />
          </div>
        )}
      </div>

      {error && (
        <div
          className="mx-3 mb-2 flex items-start gap-2 rounded-lg px-2.5 py-2 text-[12px] leading-relaxed"
          style={{ background: "var(--danger-bg)", color: "var(--danger)" }}
          role="alert"
        >
          <span className="flex-1">{error}</span>
          <button
            type="button"
            onClick={onDismissError}
            className="shrink-0 opacity-70 transition-opacity hover:opacity-100"
            aria-label="Dismiss the error"
          >
            <FiX size={13} />
          </button>
        </div>
      )}

      <div
        className="border-t px-3 py-2.5"
        style={{ borderColor: "var(--divider)" }}
      >
        <textarea
          ref={inputRef}
          value={prompt}
          onChange={(event) => onPromptChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              onSend();
            }
          }}
          rows={3}
          placeholder="Draw a…"
          disabled={isGenerating}
          className="field w-full resize-none px-2.5 py-2 text-[13px] leading-relaxed outline-none"
        />

        <div className="mt-2 flex items-center justify-between">
          <span className="text-[11px]" style={{ color: "var(--text-faint)" }}>
            Enter to send
          </span>
          <button
            type="button"
            onClick={onSend}
            disabled={isGenerating || !prompt.trim()}
            className="flex h-7 items-center gap-1.5 rounded-md px-2.5 text-[12px] font-medium transition-opacity disabled:opacity-40"
            style={{
              background: "var(--accent)",
              color: "var(--accent-contrast)",
            }}
          >
            Send
            <FiCornerDownLeft size={12} />
          </button>
        </div>
      </div>
    </aside>
    </>
  );
}

export default memo(AIAgentPanel);
