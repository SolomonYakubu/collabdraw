// @vitest-environment jsdom
/**
 * The phone-sized zoom control: a percentage chip that expands on tap.
 *
 * The desktop pill is five controls wide and ate a strip of a phone's canvas, so
 * at rest this is one chip. That collapsing is the whole component, and it is
 * where the behaviour worth testing lives:
 *
 *  - Expanding must not be one-way — there has to be a way back, and on touch
 *    there is no "click outside" unless something is listening for it, hence the
 *    full-screen button behind the controls.
 *  - "Fit" ends the interaction, so it collapses; − and + are pressed repeatedly,
 *    so they must not.
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import MobileZoomControl from "../MobileZoomControl";

const show = (zoom = 1) => {
  const props = {
    zoom,
    onZoomIn: vi.fn(),
    onZoomOut: vi.fn(),
    onReset: vi.fn(),
    onZoomToFit: vi.fn(),
  };
  const view = render(<MobileZoomControl {...props} />);

  const update = (next: Partial<typeof props>) => {
    Object.assign(props, next);
    view.rerender(<MobileZoomControl {...props} />);
  };

  return { ...view, props, update };
};

const button = (name: string) => screen.getByRole("button", { name });
const expand = () => fireEvent.click(button("Zoom controls"));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("at rest", () => {
  it("is one chip showing the zoom", () => {
    show(1.75);

    const chip = button("Zoom controls");
    expect(chip.textContent).toBe("175%");
    expect(screen.getAllByRole("button")).toHaveLength(1);
  });

  it("says it is collapsed, so the tap is worth making", () => {
    show();

    expect(button("Zoom controls").getAttribute("aria-expanded")).toBe("false");
  });
});

describe("expanded", () => {
  it("shows the full set of controls", () => {
    show();

    expand();

    expect(button("Zoom out")).toBeTruthy();
    expect(button("Reset zoom")).toBeTruthy();
    expect(button("Zoom in")).toBeTruthy();
    expect(button("Zoom to fit")).toBeTruthy();
  });

  it("keeps showing the zoom while it is being changed", () => {
    // Pinching and tapping − happen together; the readout is the feedback.
    const { update } = show(1);
    expand();

    update({ zoom: 0.5 });

    expect(button("Reset zoom").textContent).toBe("50%");
  });

  it("passes each control straight through", () => {
    const { props } = show();
    expand();

    fireEvent.click(button("Zoom out"));
    fireEvent.click(button("Zoom in"));
    fireEvent.click(button("Reset zoom"));

    expect(props.onZoomOut).toHaveBeenCalledTimes(1);
    expect(props.onZoomIn).toHaveBeenCalledTimes(1);
    expect(props.onReset).toHaveBeenCalledTimes(1);
  });

  it("stays open while the zoom is being stepped", () => {
    // Zooming out is several taps. Collapsing after each one would put the chip
    // back under the thumb and make the second tap expand it again.
    show();
    expand();

    fireEvent.click(button("Zoom out"));

    expect(button("Zoom out")).toBeTruthy();
  });

  it("collapses once the drawing has been fitted", () => {
    // "Fit" is a single decisive action — there is nothing to follow it with, so
    // the controls get out of the way.
    const { props } = show();
    expand();

    fireEvent.click(button("Zoom to fit"));

    expect(props.onZoomToFit).toHaveBeenCalledTimes(1);
    expect(screen.getAllByRole("button")).toHaveLength(1);
  });

  it("collapses on a tap anywhere else", () => {
    /*
     * On touch there is no hover and no stray click: without something covering
     * the rest of the screen, the only way out would be "fit", which changes the
     * view the user was looking at.
     */
    show();
    expand();

    fireEvent.click(button("Close zoom controls"));

    expect(screen.getAllByRole("button")).toHaveLength(1);
    expect(button("Zoom controls")).toBeTruthy();
  });
});
