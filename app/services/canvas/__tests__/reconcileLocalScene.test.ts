/**
 * The cross-tab merge. Two tabs, one localStorage key, and no tombstones — so
 * the cases worth writing down are the ones where an element is on one side
 * only, and everything turns on whether this tab had already shared it.
 */
import { describe, expect, it } from "vitest";

import { createElement } from "../elements";
import { areScenesEquivalent, reconcileScenes } from "../reconcileLocalScene";
import type { Shape } from "../../../types/shapes";

/** Only `id` and `version` are read, but these are real elements regardless. */
const shape = (id: string, version = 1): Shape => ({
  ...createElement("Square", { id, x: 0, y: 0, width: 10, height: 10 })!,
  version,
});

const ids = (elements: readonly Shape[]) => elements.map((element) => element.id);

const known = (...names: string[]) => new Set(names);

describe("elements both tabs have", () => {
  it("takes the higher version, whichever side it is on", () => {
    const merged = reconcileScenes(
      [shape("a", 3), shape("b", 1)],
      [shape("a", 1), shape("b", 7)],
      known("a", "b"),
    );

    expect(merged.map((element) => [element.id, element.version])).toEqual([
      ["a", 3],
      ["b", 7],
    ]);
  });

  it("keeps this tab's own object on a tie, so the render cache survives", () => {
    const mine = shape("a", 4);
    const theirs = shape("a", 4);

    const merged = reconcileScenes([mine], [theirs], known("a"));

    expect(merged[0]).toBe(mine);
  });
});

describe("elements only this tab has", () => {
  it("keeps one the other tab has never seen", () => {
    // Drawn here since their last read: absent from their scene means nothing.
    const merged = reconcileScenes([shape("a"), shape("new")], [shape("a")], known("a"));

    expect(ids(merged)).toEqual(["a", "new"]);
  });

  it("drops one the other tab deleted", () => {
    // Shared, and now gone from their scene: that is a deletion, not a gap.
    const merged = reconcileScenes(
      [shape("a"), shape("gone")],
      [shape("a")],
      known("a", "gone"),
    );

    expect(ids(merged)).toEqual(["a"]);
  });

  it("drops one the other tab deleted even mid-edit here", () => {
    // A concurrent local edit does not resurrect it: delete wins, which is the
    // safe direction when the alternative is an element nobody can get rid of.
    const merged = reconcileScenes(
      [shape("gone", 9)],
      [],
      known("gone"),
    );

    expect(merged).toEqual([]);
  });
});

describe("elements only the other tab has", () => {
  it("adopts one drawn there", () => {
    const merged = reconcileScenes([shape("a")], [shape("a"), shape("theirs")], known("a"));

    expect(ids(merged)).toEqual(["a", "theirs"]);
  });

  it("does not resurrect one deleted here", () => {
    // Deleted locally and they have not heard yet; our deletion stands.
    const merged = reconcileScenes([shape("a")], [shape("a"), shape("gone")], known("a", "gone"));

    expect(ids(merged)).toEqual(["a"]);
  });
});

describe("order", () => {
  it("follows the incoming scene, so the tab that saved last decides z-order", () => {
    const merged = reconcileScenes(
      [shape("a"), shape("b")],
      [shape("b"), shape("a")],
      known("a", "b"),
    );

    expect(ids(merged)).toEqual(["b", "a"]);
  });

  it("appends what only this tab has after the incoming spine", () => {
    const merged = reconcileScenes(
      [shape("mine"), shape("a")],
      [shape("a"), shape("theirs")],
      known("a"),
    );

    expect(ids(merged)).toEqual(["a", "theirs", "mine"]);
  });
});

describe("termination", () => {
  it("returns the local array itself when the merge changes nothing", () => {
    const local = [shape("a", 2), shape("b", 5)];

    const merged = reconcileScenes(
      local,
      [shape("a", 2), shape("b", 5)],
      known("a", "b"),
    );

    // Reference equality is the caller's signal to skip adopting, which is what
    // stops two tabs writing and re-merging each other forever.
    expect(merged).toBe(local);
  });

  it("settles after one exchange when both tabs drew concurrently", () => {
    // A has `a`, B has `b`, neither knows the other's. B merges A's save first.
    const bMerged = reconcileScenes([shape("b")], [shape("a")], known());
    expect(ids(bMerged)).toEqual(["a", "b"]);

    // B saves that, and A adopts it.
    const aMerged = reconcileScenes([shape("a")], bMerged, known("a"));
    expect(ids(aMerged)).toEqual(["a", "b"]);

    // A's own save now tells B nothing new, so the exchange stops here.
    expect(reconcileScenes(bMerged, aMerged, known("a", "b"))).toBe(bMerged);
  });
});

describe("a cleared scene", () => {
  it("clears this tab too, the other tab having reset the canvas", () => {
    expect(reconcileScenes([shape("a"), shape("b")], [], known("a", "b"))).toEqual([]);
  });

  it("cannot wipe a tab whose ids it never knew", () => {
    // A tab that could not read the store has an empty `knownIds`, so its empty
    // save is read as "has not seen these yet" rather than as a deletion.
    const local = [shape("a"), shape("b")];

    expect(reconcileScenes(local, [], known())).toBe(local);
  });
});

describe("areScenesEquivalent", () => {
  it("compares ids, versions and order", () => {
    expect(areScenesEquivalent([shape("a", 1)], [shape("a", 1)])).toBe(true);
    expect(areScenesEquivalent([shape("a", 1)], [shape("a", 2)])).toBe(false);
    expect(areScenesEquivalent([shape("a")], [shape("b")])).toBe(false);
    expect(areScenesEquivalent([shape("a")], [shape("a"), shape("b")])).toBe(false);
    expect(
      areScenesEquivalent([shape("a"), shape("b")], [shape("b"), shape("a")]),
    ).toBe(false);
  });
});
