// @vitest-environment jsdom
/**
 * The assistant panel — the transcript, the two mode switches, and the composer.
 *
 * The panel is presentational: every action is a callback, and the interesting
 * behaviour is in what it decides to show.
 *
 *  - **Hidden turns.** When "Live" is on, the app takes a turn on the model's
 *    behalf after each edit. Those turns are real history — the model needs them
 *    — but showing them would fill the panel with prompts the user never typed.
 *  - **The empty state.** Suggestions replace the transcript, and one click has
 *    to both fill the box and put the caret in it; a suggestion that fills the
 *    box without focusing makes the user click twice to send.
 *  - **The composer.** Enter sends and Shift+Enter does not, which is the whole
 *    reason the key handler exists; and Send refuses an empty prompt rather than
 *    spending a request on whitespace.
 *
 * `scrollIntoView` is stubbed because jsdom has no layout — and stubbed rather
 * than ignored, since the panel calls it unconditionally and would otherwise
 * throw on every new message.
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import AIAgentPanel from "../AIAgentPanel";

type PanelProps = React.ComponentProps<typeof AIAgentPanel>;

const said = (role: "user" | "model", text: string, hidden = false) => ({
  role,
  parts: [{ text }],
  hidden,
});

const handlers = () => ({
  onToggleAutoRespond: vi.fn(),
  onPromptChange: vi.fn(),
  onSend: vi.fn(),
  onDismissError: vi.fn(),
  onClose: vi.fn(),
  onResetConversation: vi.fn(),
});

const open = (overrides: Partial<PanelProps> = {}) => {
  const props: PanelProps = {
    isOpen: true,
    prompt: "",
    history: [],
    isGenerating: false,
    error: null,
    autoRespond: false,
    ...handlers(),
    ...overrides,
  };
  const view = render(<AIAgentPanel {...props} />);

  /** Change what the panel is showing, as a reply arriving does. */
  const update = (next: Partial<PanelProps>) => {
    Object.assign(props, next);
    view.rerender(<AIAgentPanel {...props} />);
  };

  return { ...view, props, update };
};

/** The transcript, in order, whoever said each line. */
const transcript = () =>
  Array.from(document.querySelectorAll("aside p")).map(
    (line) => line.textContent,
  );

const composer = () => screen.getByRole("textbox") as HTMLTextAreaElement;
const button = (name: string) =>
  screen.getByRole("button", { name }) as HTMLButtonElement;
const switchFor = (name: string) => screen.getByRole("switch", { name });

const LIVE = "Live: reply automatically after each move";

beforeEach(() => {
  // jsdom has no layout, and the panel scrolls to the newest line on every
  // change; without this the first message throws instead of rendering.
  Element.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("opening and closing", () => {
  it("renders nothing at all while closed", () => {
    // Not merely hidden: the panel is over the canvas, and a display-none aside
    // would still hold the focused textarea and keep taking keystrokes.
    open({ isOpen: false, history: [said("user", "a flowchart")] });

    expect(screen.queryByRole("complementary")).toBeNull();
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("puts the caret in the composer as it opens", () => {
    // The panel is opened to type into. Focusing on mount is what makes the
    // keyboard shortcut that opens it useful.
    open();

    expect(document.activeElement).toBe(composer());
  });

  it("focuses the composer again on the next opening", () => {
    // The panel is mounted once and toggled, so the focus effect has to key off
    // `isOpen` rather than the mount.
    const { update } = open();
    composer().blur();

    update({ isOpen: false });
    update({ isOpen: true });

    expect(document.activeElement).toBe(composer());
  });

  it("closes from the header button and from the backdrop behind it", () => {
    // The backdrop is the only way out on a phone, where the panel covers the
    // screen and the header button is easy to miss with a thumb.
    const { props, container } = open();

    fireEvent.click(button("Close the assistant"));
    fireEvent.click(container.querySelector('[aria-hidden="true"]')!);

    expect(props.onClose).toHaveBeenCalledTimes(2);
  });
});

describe("the transcript", () => {
  it("shows what was said, in the order it was said", () => {
    open({
      history: [
        said("user", "a flowchart for a support ticket"),
        said("model", "Drawn — six boxes and a decision."),
      ],
    });

    expect(transcript()).toEqual([
      "a flowchart for a support ticket",
      "Drawn — six boxes and a decision.",
    ]);
  });

  it("keeps the automatic turns out of it", () => {
    /*
     * With "Live" on, the app sends a turn of its own after every edit. Those
     * belong in the history the model sees and nowhere else: shown, they read as
     * a column of prompts the user is being made to say.
     */
    open({
      history: [
        said("user", "draw a pendulum"),
        said("model", "Done."),
        said("user", "the canvas changed, your turn", true),
        said("model", "Labelled the forces."),
      ],
    });

    expect(transcript()).toEqual([
      "draw a pendulum",
      "Done.",
      "Labelled the forces.",
    ]);
  });

  it("tints only the user's own lines", () => {
    // One tint and one plain paragraph is the whole distinction; a bubble per
    // message would make the model's prose harder to read, which is most of it.
    open({ history: [said("user", "a URL shortener"), said("model", "Drawn.")] });

    const [mine, theirs] = Array.from(document.querySelectorAll("aside p"));
    expect(mine.className).toContain("self-end");
    expect(theirs.className).not.toContain("self-end");
  });

  it("survives a turn that carries no text", () => {
    // A blocked or empty response arrives as a turn with no parts. It must not
    // take the panel down with it.
    open({ history: [{ role: "model", parts: [] }] });

    expect(transcript()).toEqual([""]);
  });

  it("scrolls to the newest line as it arrives", () => {
    // The transcript overflows after a few exchanges, and a reply that lands
    // below the fold looks like nothing happened.
    const { update } = open({ history: [said("user", "a tic-tac-toe board")] });

    update({ history: [said("user", "a tic-tac-toe board"), said("model", "Drawn.")] });

    expect(Element.prototype.scrollIntoView).toHaveBeenCalled();
  });

  it("says it is working, once there is a transcript to say it in", () => {
    open({ history: [said("user", "a pendulum")], isGenerating: true });

    expect(screen.getByText("Drawing…")).toBeTruthy();
  });

  it("stops saying so when the drawing lands", () => {
    const { update } = open({
      history: [said("user", "a pendulum")],
      isGenerating: true,
    });

    update({ history: [said("user", "a pendulum"), said("model", "Drawn.")], isGenerating: false });

    expect(screen.queryByText("Drawing…")).toBeNull();
  });
});

describe("the empty state", () => {
  it("offers something to try instead of an empty box", () => {
    // A panel that only says "Draw a…" gives no idea of what it can be asked
    // for; the suggestions are the documentation.
    open();

    expect(screen.getByRole("button", { name: "design a URL shortener" })).toBeTruthy();
  });

  it("fills the composer from a suggestion and leaves the caret in it", () => {
    // Filling without focusing means a second click to send — and the point of
    // the suggestions is that one press gets you a drawing.
    const { props } = open();
    composer().blur();

    fireEvent.click(button("a tic-tac-toe board"));

    expect(props.onPromptChange).toHaveBeenCalledWith("a tic-tac-toe board");
    expect(document.activeElement).toBe(composer());
  });

  it("puts the suggestions away once anything has been said", () => {
    open({ history: [said("user", "a pendulum")] });

    expect(screen.queryByRole("button", { name: "a tic-tac-toe board" })).toBeNull();
  });

  it("offers no way to clear a conversation that has not started", () => {
    // The bin appears with the transcript. On an empty panel it does nothing,
    // and a button that does nothing reads as broken.
    open();

    expect(screen.queryByRole("button", { name: "Clear the conversation" })).toBeNull();
  });

  it("counts a transcript of nothing but automatic turns as empty", () => {
    /*
     * The bin and the suggestions both key off the visible messages rather than
     * the raw history — otherwise a board where "Live" fired once would offer to
     * clear a conversation with nothing in it.
     */
    open({ history: [said("user", "the canvas changed, your turn", true)] });

    expect(screen.queryByRole("button", { name: "Clear the conversation" })).toBeNull();
    expect(screen.getByRole("button", { name: "a tic-tac-toe board" })).toBeTruthy();
  });

  it("clears the conversation when there is one to clear", () => {
    const { props } = open({ history: [said("user", "a pendulum")] });

    fireEvent.click(button("Clear the conversation"));

    expect(props.onResetConversation).toHaveBeenCalledTimes(1);
  });
});

describe("the Live switch", () => {
  it("reports what it is set to", () => {
    // It is `role="switch"`, so its state is `aria-checked` — a coloured pill
    // says nothing to a screen reader.
    open({ autoRespond: true });

    expect(switchFor(LIVE).getAttribute("aria-checked")).toBe("true");
  });

  it("is the only switch in the header", () => {
    // The Architecture toggle used to sit beside it and is gone: the endpoint's
    // classifier already picks the system kind for a request about
    // infrastructure, so a second pill only added a mode to get wrong.
    open();

    expect(screen.getAllByRole("switch")).toHaveLength(1);
  });

  it("asks for the opposite of what it currently is", () => {
    // The panel holds no state of its own: it sends the negation up and waits to
    // be told the new value. A hardcoded `true` would make it one-way.
    const { props } = open({ autoRespond: false });

    fireEvent.click(switchFor(LIVE));

    expect(props.onToggleAutoRespond).toHaveBeenCalledWith(true);
  });

  it("explains in the tooltip which way it is facing", () => {
    // The pill's colour is the only other cue, and it means nothing on first
    // sight; the title says what clicking will do.
    const { update } = open({ autoRespond: true });

    expect(switchFor(LIVE).getAttribute("title")).toContain("Live is on");

    update({ autoRespond: false });

    expect(switchFor(LIVE).getAttribute("title")).toContain("Live is off");
  });
});

describe("the error", () => {
  it("announces itself, being the reason nothing was drawn", () => {
    // `role="alert"`: the user is looking at the canvas waiting for a drawing,
    // not at the panel.
    open({ error: "The model is rate limited. Try again in a minute." });

    expect(screen.getByRole("alert").textContent).toContain("rate limited");
  });

  it("can be dismissed without closing the panel", () => {
    const { props } = open({ error: "Something went wrong." });

    fireEvent.click(button("Dismiss the error"));

    expect(props.onDismissError).toHaveBeenCalledTimes(1);
    expect(props.onClose).not.toHaveBeenCalled();
  });

  it("shows nothing when there is nothing wrong", () => {
    open();

    expect(screen.queryByRole("alert")).toBeNull();
  });
});

describe("the composer", () => {
  it("shows the prompt it was given and reports each keystroke", () => {
    // The prompt lives in the editor's state so that it survives the panel being
    // closed mid-sentence; the textarea is controlled from it.
    const { props } = open({ prompt: "a flowchart" });

    expect(composer().value).toBe("a flowchart");
    fireEvent.change(composer(), { target: { value: "a flowchart for QA" } });

    expect(props.onPromptChange).toHaveBeenCalledWith("a flowchart for QA");
  });

  it("sends on Enter, and does not also type a newline", () => {
    const { props } = open({ prompt: "a pendulum" });

    const notPrevented = fireEvent.keyDown(composer(), { key: "Enter" });

    expect(props.onSend).toHaveBeenCalledTimes(1);
    expect(notPrevented).toBe(false);
  });

  it("keeps Shift+Enter as a newline", () => {
    // Prompts run to several lines — "a flowchart, then label the branches" — and
    // there has to be a way to write them.
    const { props } = open({ prompt: "a pendulum" });

    fireEvent.keyDown(composer(), { key: "Enter", shiftKey: true });

    expect(props.onSend).not.toHaveBeenCalled();
  });

  it("sends from the button too", () => {
    const { props } = open({ prompt: "a pendulum" });

    fireEvent.click(button("Send"));

    expect(props.onSend).toHaveBeenCalledTimes(1);
  });

  it("refuses to spend a request on an empty prompt", () => {
    open({ prompt: "" });

    expect(button("Send").disabled).toBe(true);
  });

  it("counts whitespace as empty", () => {
    // The box looks filled and the request would be a blank turn, which the
    // model answers by asking what was meant.
    open({ prompt: "   \n  " });

    expect(button("Send").disabled).toBe(true);
  });

  it("closes the box while a drawing is in flight", () => {
    /*
     * Two requests at once would race to write to the same canvas, and the
     * second reply would be generated against a scene the first had already
     * changed. Both the box and the button are shut.
     */
    open({ prompt: "a pendulum", isGenerating: true });

    expect(composer().disabled).toBe(true);
    expect(button("Send").disabled).toBe(true);
  });

  it("opens up again once the drawing has landed", () => {
    const { update } = open({ prompt: "a pendulum", isGenerating: true });

    update({ isGenerating: false });

    expect(composer().disabled).toBe(false);
    expect(button("Send").disabled).toBe(false);
  });
});
