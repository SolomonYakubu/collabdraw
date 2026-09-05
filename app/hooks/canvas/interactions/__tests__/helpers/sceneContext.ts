/**
 * A stand-in for everything the interaction layer is handed at run time: the
 * scene refs `useScene` owns, the visuals setters `usePointerInteraction` owns,
 * and the viewport's pixel-to-world conversion.
 *
 * `applyElements` is the important one. The real implementation runs the updater
 * against a ref that it writes back synchronously, so two calls in one gesture
 * see each other's work — a fake that only recorded the call would let a
 * regression there pass unnoticed. This one keeps that behaviour and records the
 * options each call passed, since `commit`, `broadcast`, `changedIds` and
 * `deletedIds` are what decide undo granularity and what peers are told.
 */
import type { Point, Shape, ToolType } from "../../../../../types/shapes";
import type { ApplyOptions } from "../../../useScene";
import { EMPTY_VISUALS, type InteractionVisuals } from "../../types";

export interface AppliedCall {
  options: ApplyOptions;
  result: Shape[];
}

export const makeContext = (
  elements: readonly Shape[] = [],
  overrides: { zoom?: number; toolLocked?: boolean; selectedIds?: string[] } = {},
) => {
  const zoom = overrides.zoom ?? 1;

  const context = {
    elementsRef: { current: [...elements] as Shape[] },
    erasingRef: { current: new Set<string>() },
    trailRef: { current: [] as Point[] },
    selectedIdsRef: { current: overrides.selectedIds ?? [] },
    toolLocked: overrides.toolLocked ?? false,

    /** Everything the fake recorded, for the assertions. */
    applied: [] as AppliedCall[],
    visuals: { ...EMPTY_VISUALS } as InteractionVisuals,
    patches: [] as Partial<InteractionVisuals>[],
    resets: 0,
    pending: [] as (Shape | null)[],
    selections: [] as string[][],
    tools: [] as ToolType[],
    snapCalls: [] as Array<{
      pointer: Point;
      options?: { exclude?: string; disabled?: boolean };
    }>,
    /** What `applyPointSnap` should pretend the pointer locked onto. */
    snapTo: null as Point | null,

    applyElements(
      updater: Shape[] | ((previous: Shape[]) => Shape[]),
      options: ApplyOptions = {},
    ): Shape[] {
      const next =
        typeof updater === "function"
          ? updater(context.elementsRef.current)
          : updater;

      context.elementsRef.current = next;
      context.applied.push({ options, result: next });
      return next;
    },

    patchVisuals(patch: Partial<InteractionVisuals>): void {
      context.patches.push(patch);
      context.visuals = { ...context.visuals, ...patch };
    },

    resetVisuals(): void {
      context.resets += 1;
      context.visuals = { ...EMPTY_VISUALS };
      context.erasingRef.current = new Set();
      context.trailRef.current = [];
    },

    setPending(element: Shape | null): void {
      context.pending.push(element);
    },

    setSelectedIds(ids: string[]): void {
      context.selections.push(ids);
      context.selectedIdsRef.current = ids;
    },

    setTool(tool: ToolType): void {
      context.tools.push(tool);
    },

    /** The real one divides by the zoom, so a threshold is constant on screen. */
    worldThreshold(pixels: number): number {
      return pixels / zoom;
    },

    applyPointSnap(
      pointer: Point,
      options?: { exclude?: string; disabled?: boolean },
    ): Point {
      context.snapCalls.push({ pointer, options });
      return options?.disabled ? pointer : (context.snapTo ?? pointer);
    },

    /** The single element in the scene with this id, as it now stands. */
    find(id: string): Shape {
      const element = context.elementsRef.current.find((item) => item.id === id);
      if (!element) {
        throw new Error(`no element ${id} in the scene`);
      }
      return element;
    },

    get lastApplied(): AppliedCall {
      return context.applied[context.applied.length - 1];
    },
  };

  return context;
};

export type FakeContext = ReturnType<typeof makeContext>;
