// @vitest-environment jsdom
/**
 * The desktop zoom pill: − 100% + | fit.
 *
 * Small enough that the only things worth pinning are the ones a reader cannot
 * guess: the percentage is a *button* — the readout doubles as "reset to 100%",
 * which is the fastest way back from a wild pinch — and every control carries the
 * keyboard shortcut in its tooltip, since that is where the shortcuts are
 * documented in this app.
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import ZoomControls from "../ZoomControls";

const show = (zoom = 1) => {
  const props = {
    zoom,
    onZoomIn: vi.fn(),
    onZoomOut: vi.fn(),
    onReset: vi.fn(),
    onZoomToFit: vi.fn(),
  };
  const view = render(<ZoomControls {...props} />);
  return { ...view, props };
};

const button = (name: string) => screen.getByRole("button", { name });

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("the readout", () => {
  it("shows the zoom as a whole percentage", () => {
    // The zoom is a float that lands on values like 1.1000000000000003 after a
    // few steps; unrounded, the pill would show sixteen digits.
    show(1.234);

    expect(button("Reset zoom").textContent).toBe("123%");
  });

  it("shows a zoomed-out view as a percentage too", () => {
    show(0.335);

    expect(button("Reset zoom").textContent).toBe("34%");
  });

  it("is itself the way back to 100%", () => {
    // The readout is the button. Clicking the number you are unhappy with is
    // more discoverable than hunting for a separate reset control.
    const { props } = show(4);

    fireEvent.click(button("Reset zoom"));

    expect(props.onReset).toHaveBeenCalledTimes(1);
  });
});

describe("the controls", () => {
  it("steps in and out, and fits the drawing", () => {
    const { props } = show();

    fireEvent.click(button("Zoom out"));
    fireEvent.click(button("Zoom in"));
    fireEvent.click(button("Zoom to fit"));

    expect(props.onZoomOut).toHaveBeenCalledTimes(1);
    expect(props.onZoomIn).toHaveBeenCalledTimes(1);
    expect(props.onZoomToFit).toHaveBeenCalledTimes(1);
  });

  it("teaches the shortcut for each one", () => {
    // There is no shortcuts dialog in the app; the tooltips are the reference.
    show();

    expect(button("Zoom out").getAttribute("title")).toContain("Ctrl+-");
    expect(button("Reset zoom").getAttribute("title")).toContain("Ctrl+0");
    expect(button("Zoom in").getAttribute("title")).toContain("Ctrl++");
    expect(button("Zoom to fit").getAttribute("title")).toContain("Shift+1");
  });

  it("names every control for a screen reader, the icons being wordless", () => {
    show();

    expect(screen.getAllByRole("button")).toHaveLength(4);
  });
});
