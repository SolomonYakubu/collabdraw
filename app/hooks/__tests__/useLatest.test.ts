// @vitest-environment jsdom
/**
 * A ref mirror of a prop, so a listener registered once can read the current
 * value without being torn down and re-subscribed on every change.
 *
 * The failure it exists to prevent is a stale closure: a `useEffect(..., [])`
 * that captures `onChange` from the first render keeps calling that one for the
 * life of the component, which in this app means messages sent down a socket the
 * page has already replaced. The alternative — listing the value as a dependency
 * — re-registers the listener on every keystroke, and for a pointer or keyboard
 * handler that is a measurable cost.
 */
import { cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useLatest } from "../useLatest";

afterEach(cleanup);

describe("useLatest", () => {
  it("holds the value from the first render", () => {
    const { result } = renderHook(() => useLatest("first"));

    expect(result.current.current).toBe("first");
  });

  it("has the new value in hand by the time the render commits", () => {
    // Assigned during render, not in an effect: a handler that fires between the
    // render and the effect would otherwise still see the old value.
    const { result, rerender } = renderHook(({ value }) => useLatest(value), {
      initialProps: { value: "first" },
    });

    rerender({ value: "second" });

    expect(result.current.current).toBe("second");
  });

  it("keeps the same ref object, so a dependency array never sees it change", () => {
    const { result, rerender } = renderHook(({ value }) => useLatest(value), {
      initialProps: { value: 1 },
    });
    const initial = result.current;

    rerender({ value: 2 });

    expect(result.current).toBe(initial);
  });

  it("lets a listener registered once call the newest callback", () => {
    /*
     * The whole point, written as the situation it is used in: the effect runs on
     * mount only, and by the time it fires the component has been handed a
     * different callback.
     */
    const first = vi.fn();
    const second = vi.fn();
    let fire = () => {};

    const { rerender } = renderHook(
      ({ onEvent }: { onEvent: () => void }) => {
        const latest = useLatest(onEvent);
        fire = () => latest.current();
      },
      { initialProps: { onEvent: first } },
    );

    rerender({ onEvent: second });
    fire();

    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it("mirrors a value that is falsy or absent", () => {
    // `undefined` is a real value here — an optional callback that has not been
    // supplied — and must not be confused with "not yet initialised".
    const { result, rerender } = renderHook(
      ({ value }: { value: string | undefined }) => useLatest(value),
      { initialProps: { value: "first" as string | undefined } },
    );

    rerender({ value: undefined });

    expect(result.current.current).toBeUndefined();
  });
});
