/**
 * Connector routing for system diagrams.
 *
 * The canvas elbow router is good at getting one arrow around an obstacle, but
 * it solves each arrow on its own: every connector leaving the bottom of a box
 * leaves from the same anchor, and every route crossing the space between two
 * rows picks the same cheapest line to cross it. Draw forty-six arrows that way
 * and dozens of them lie exactly on top of each other — the diagram is
 * geometrically correct and impossible to read.
 *
 * So the arrows are planned together, before any of them is drawn, and each is
 * handed explicit waypoints built from three shared resources:
 *
 *   - **Ports.** Connectors on the same side of the same box fan out to their own
 *     column, ordered by where their other end is, so they stop sharing a
 *     descent.
 *   - **Lanes.** The channel between two bands is divided into lanes, and the
 *     sideways part of a route happens in a lane of its own. Runs that do not
 *     overlap sideways share a lane, so a channel needs far fewer lanes than it
 *     has connectors.
 *   - **Corridors.** A connector that skips a band crosses it through one of the
 *     gutters between that band's boxes, stepping lane to lane. Without this a
 *     long connector descends in one straight column, and whichever column the
 *     router picks it will share with the next long connector.
 *
 * The result is a staircase for long connectors and a plain two-bend elbow for
 * short ones, with the elbow router left to do the small stuff: it still owns
 * the stub out of each port and any leg whose lane or corridor could not be
 * found.
 */
import type { Point } from "../../types/shapes";
import type { LaidOutSystemNode, SystemLayout } from "./systemLayout";
import type { SystemEdge } from "./system";

/** How far a connector runs straight out of its port before it may turn. */
const STUB = 30;
/** Keep ports this far inside the edges of a box. */
const PORT_INSET = 16;
/** Preferred distance between two lanes in the same channel. */
export const LANE_PITCH = 26;
/** Two runs may share a lane if they stay this far apart sideways. */
const LANE_CLEARANCE = 28;
/** Lanes stay this far clear of the boxes on either side of the channel. */
const LANE_MARGIN = STUB + 8;
/**
 * How far a corridor stays from the boxes beside it. The elbow router treats
 * anything within its own clearance as blocked, so a corridor closer than that
 * would be abandoned by the very router meant to follow it.
 */
const GUTTER_CLEARANCE = 24;
/** Two corridors through the same band stay this far apart. */
const COLUMN_PITCH = 18;

export interface PlannedRoute {
  /** Index into the edge list that was planned. */
  edge: number;
  waypoints: Point[];
}

export interface RoutePlan {
  routes: PlannedRoute[];
  /** Lanes needed in the channel that follows each band, by band index. */
  laneCount: Map<number, number>;
}

/** A connector's sideways run through one channel, before lanes are assigned. */
interface Run {
  edge: number;
  channel: number;
  /** Cross-axis interval the run occupies, ordered low to high. */
  low: number;
  high: number;
}

/**
 * Assign lanes by the left-edge algorithm: walk the runs in order of where they
 * start and drop each one into the first lane it fits in.
 *
 * Sharing matters more than it looks. A tier that fans out to eleven children
 * has eleven runs, but the ones heading left and the ones heading right never
 * meet, so they occupy the same lanes and the channel stays shallow.
 */
const assignLanes = (runs: readonly Run[]): Map<number, number> => {
  const lanes = new Map<number, number>();
  const filledTo: number[] = [];

  const ordered = [...runs].sort(
    (a, b) => a.low - b.low || a.high - b.high || a.edge - b.edge,
  );

  for (const run of ordered) {
    let lane = filledTo.findIndex((end) => run.low > end + LANE_CLEARANCE);

    if (lane === -1) {
      lane = filledTo.length;
      filledTo.push(run.high);
    } else {
      filledTo[lane] = Math.max(filledTo[lane], run.high);
    }

    lanes.set(run.edge, lane);
  }

  return lanes;
};

/**
 * Spread the connectors that share one side of one box across their own
 * columns, ordered by where each is heading so they do not cross on the way out.
 *
 * The spread is capped as well as the box: a port too far from the centre would
 * make the stub leave sideways rather than along the flow, which is the one
 * thing the port is there to avoid. When the side is too short to give everyone a
 * port at `MIN_PORT_PITCH`, connectors share the ports that do fit rather than
 * fanning to positions too close together to tell apart.
 */
const assignPorts = (
  members: ReadonlyArray<{ edge: number; towards: number }>,
  centre: number,
  extent: number,
  depth: number,
): Map<number, number> => {
  const ports = new Map<number, number>();

  const ordered = [...members].sort(
    (a, b) => a.towards - b.towards || a.edge - b.edge,
  );

  if (ordered.length === 1) {
    ports.set(ordered[0].edge, centre);
    return ports;
  }

  const spread = Math.min(
    Math.max(0, extent - PORT_INSET * 2),
    // Beyond this the stub would read as leaving the side of the box.
    Math.max(0, (depth + STUB) * 2 - 12),
  );

  ordered.forEach(({ edge }, at) => {
    const fraction = (at + 0.5) / ordered.length - 0.5;
    ports.set(edge, centre + fraction * spread);
  });

  return ports;
};

/**
 * Columns a connector may cross one band through: the gutters between its boxes
 * and the space either side of them, sampled at the corridor pitch.
 */
const gutterSlots = (
  occupied: ReadonlyArray<{ near: number; far: number }>,
  window: { near: number; far: number },
): number[] => {
  const slots: number[] = [];

  const add = (low: number, high: number) => {
    if (high < low) {
      return;
    }
    const fits = Math.floor((high - low) / COLUMN_PITCH) + 1;
    // Centre what fits, so a lone corridor sits in the middle of its gutter.
    const used = (fits - 1) * COLUMN_PITCH;
    const start = low + (high - low - used) / 2;
    for (let at = 0; at < fits; at += 1) {
      slots.push(start + at * COLUMN_PITCH);
    }
  };

  let cursor = window.near;
  for (const box of occupied) {
    add(cursor, box.near - GUTTER_CLEARANCE);
    cursor = Math.max(cursor, box.far + GUTTER_CLEARANCE);
  }
  add(cursor, window.far);

  return slots;
};

/**
 * Hand out the corridors through one band, keeping the connectors in the order
 * they arrive in so they do not cross each other inside the band, and staying as
 * close as possible to where each one would rather cross.
 *
 * A band with more connectors crossing it than it has gutters has to double some
 * up. They are spread evenly rather than piled into the first gutter: sharing a
 * gutter costs an overlap as deep as the band, while piling up costs one as long
 * as the whole crossing.
 */
const assignCorridors = (
  demand: ReadonlyArray<{ edge: number; prefers: number }>,
  slots: readonly number[],
): Map<number, number> => {
  const columns = new Map<number, number>();

  if (slots.length === 0) {
    return columns;
  }

  const ordered = [...demand].sort(
    (a, b) => a.prefers - b.prefers || a.edge - b.edge,
  );

  if (ordered.length > slots.length) {
    ordered.forEach(({ edge }, at) => {
      const spread = Math.round(
        (at * (slots.length - 1)) / (ordered.length - 1),
      );
      columns.set(edge, slots[spread]);
    });

    return columns;
  }

  let slot = 0;
  ordered.forEach(({ edge, prefers }, at) => {
    // Leave a slot for each connector still waiting, so order is preserved.
    const last = slots.length - 1 - (ordered.length - 1 - at);

    while (
      slot < last &&
      Math.abs(slots[slot + 1] - prefers) < Math.abs(slots[slot] - prefers)
    ) {
      slot += 1;
    }

    columns.set(edge, slots[slot]);
    slot += 1;
  });

  return columns;
};

/** One connector, once its bands and sides are known. */
interface Planned {
  edge: number;
  from: LaidOutSystemNode;
  to: LaidOutSystemNode;
  /** True when the connector travels along the flow, false when against it. */
  forward: boolean;
  /** Channels it passes through, in travel order. */
  channels: number[];
  /** Bands it crosses on the way, in travel order. */
  crossed: number[];
}

/**
 * Plan every connector's waypoints for a laid-out system graph.
 *
 * Coordinates are in the layout's own space, so the caller adds its origin. The
 * plan is deterministic: ties fall back to edge order, never to anything that
 * depends on the iteration order of a map.
 */
export const planSystemRoutes = (
  layout: SystemLayout,
  edges: readonly SystemEdge[],
  direction: "down" | "right",
): RoutePlan => {
  const horizontal = direction === "right";
  const byId = new Map(layout.nodes.map((node) => [node.id, node]));

  // Flow is the axis bands advance along; cross is the axis they spread across.
  const flowStart = (node: LaidOutSystemNode) => (horizontal ? node.x : node.y);
  const flowEnd = (node: LaidOutSystemNode) =>
    horizontal ? node.x + node.width : node.y + node.height;
  const flowExtent = (node: LaidOutSystemNode) =>
    horizontal ? node.width : node.height;
  const crossStart = (node: LaidOutSystemNode) => (horizontal ? node.y : node.x);
  const crossEnd = (node: LaidOutSystemNode) =>
    horizontal ? node.y + node.height : node.x + node.width;
  const crossCentre = (node: LaidOutSystemNode) =>
    horizontal ? node.y + node.height / 2 : node.x + node.width / 2;
  const crossExtent = (node: LaidOutSystemNode) =>
    horizontal ? node.height : node.width;
  const at = (flow: number, cross: number): Point =>
    horizontal ? { x: flow, y: cross } : { x: cross, y: flow };

  // Where each band begins and ends along the flow axis, and what sits in it.
  const bandNear = new Map<number, number>();
  const bandFar = new Map<number, number>();
  const bandNodes = new Map<number, LaidOutSystemNode[]>();

  for (const node of layout.nodes) {
    const near = bandNear.get(node.band);
    const far = bandFar.get(node.band);

    bandNear.set(
      node.band,
      near === undefined ? flowStart(node) : Math.min(near, flowStart(node)),
    );
    bandFar.set(
      node.band,
      far === undefined ? flowEnd(node) : Math.max(far, flowEnd(node)),
    );

    const members = bandNodes.get(node.band);
    if (members) {
      members.push(node);
    } else {
      bandNodes.set(node.band, [node]);
    }
  }

  // Corridors may use the full width the drawing already occupies, but no more:
  // a route around the outside would stretch the picture to save a crossing.
  const window = {
    near: Math.min(...layout.nodes.map(crossStart)),
    far: Math.max(...layout.nodes.map(crossEnd)),
  };

  const planned: Planned[] = [];
  /** Connectors that share one side of one box, by side. */
  const sides = new Map<string, Array<{ edge: number; towards: number }>>();

  edges.forEach((edge, index) => {
    const from = byId.get(edge.from);
    const to = byId.get(edge.to);

    if (!from || !to || from.id === to.id || from.band === to.band) {
      // Same-band connectors travel sideways through the row itself; there is no
      // channel to give them, so the elbow router keeps them.
      return;
    }

    const forward = to.band > from.band;
    const channels: number[] = [];
    const crossed: number[] = [];

    // Channels are named for the band they follow, so the channel between bands
    // 2 and 3 is channel 2 whichever way a connector runs through it.
    if (forward) {
      for (let band = from.band; band < to.band; band += 1) {
        channels.push(band);
      }
      for (let band = from.band + 1; band < to.band; band += 1) {
        crossed.push(band);
      }
    } else {
      for (let band = from.band - 1; band >= to.band; band -= 1) {
        channels.push(band);
      }
      for (let band = from.band - 1; band > to.band; band -= 1) {
        crossed.push(band);
      }
    }

    planned.push({ edge: index, from, to, forward, channels, crossed });

    const record = (node: LaidOutSystemNode, outgoing: boolean, towards: number) => {
      const key = `${node.id}:${outgoing === forward ? "far" : "near"}`;
      const members = sides.get(key);
      if (members) {
        members.push({ edge: index, towards });
      } else {
        sides.set(key, [{ edge: index, towards }]);
      }
    };

    record(from, true, crossCentre(to));
    record(to, false, crossCentre(from));
  });

  // Ports first: everything downstream is measured between ports, not centres.
  const portFor = new Map<string, number>();
  for (const [key, members] of sides) {
    const node = byId.get(key.slice(0, key.lastIndexOf(":")))!;
    const ports = assignPorts(
      members,
      crossCentre(node),
      crossExtent(node),
      flowExtent(node) / 2,
    );
    for (const [edge, port] of ports) {
      portFor.set(`${key}#${edge}`, port);
    }
  }

  const portOf = (
    node: LaidOutSystemNode,
    outgoing: boolean,
    forward: boolean,
    edge: number,
  ) =>
    portFor.get(`${node.id}:${outgoing === forward ? "far" : "near"}#${edge}`) ??
    crossCentre(node);

  const startPortOf = (plan: Planned) =>
    portOf(plan.from, true, plan.forward, plan.edge);
  const endPortOf = (plan: Planned) =>
    portOf(plan.to, false, plan.forward, plan.edge);

  // Corridors, band by band. A connector would rather cross each band at the
  // point it has reached on its way from one port to the other, so it arrives at
  // the far end without doubling back.
  const corridorDemand = new Map<number, Array<{ edge: number; prefers: number }>>();

  for (const plan of planned) {
    const start = startPortOf(plan);
    const end = endPortOf(plan);

    plan.crossed.forEach((band, at) => {
      const prefers =
        start + ((end - start) * (at + 1)) / (plan.crossed.length + 1);
      const demand = corridorDemand.get(band);
      if (demand) {
        demand.push({ edge: plan.edge, prefers });
      } else {
        corridorDemand.set(band, [{ edge: plan.edge, prefers }]);
      }
    });
  }

  /** `edge:band` -> the column that connector crosses that band in. */
  const corridorFor = new Map<string, number>();

  /** Columns the band before this one crossed in, and which band that was. */
  let taken: number[] = [];
  let takenBand = Number.NaN;

  for (const band of [...corridorDemand.keys()].sort((a, b) => a - b)) {
    const demand = corridorDemand.get(band)!;
    const occupied = [...(bandNodes.get(band) ?? [])]
      .map((node) => ({ near: crossStart(node), far: crossEnd(node) }))
      .sort((a, b) => a.near - b.near);

    const slots = gutterSlots(occupied, window);

    // A connector crossing this band and one crossing the band before it both
    // turn in the channel between the two, so in the same column they run along
    // each other from one's lane to the other's. Skip the neighbour's columns
    // while enough are left to serve everyone here.
    const clear =
      takenBand === band - 1
        ? slots.filter((slot) =>
            taken.every((used) => Math.abs(slot - used) > COLUMN_PITCH / 2),
          )
        : slots;

    const columns = assignCorridors(
      demand,
      clear.length >= demand.length ? clear : slots,
    );

    taken = [...columns.values()];
    takenBand = band;

    for (const [edge, column] of columns) {
      corridorFor.set(`${edge}:${band}`, column);
    }
  }

  /**
   * The cross positions a connector passes through, in travel order: its own
   * port, a corridor for every band it crosses, then the far port. Consecutive
   * pairs are the sideways runs, one per channel.
   */
  const columnsOf = (plan: Planned): number[] => {
    const columns = [startPortOf(plan)];

    for (const band of plan.crossed) {
      const corridor = corridorFor.get(`${plan.edge}:${band}`);
      // No gutter to cross this band in: stay in the column we are already in
      // and let the elbow router find its own way through.
      columns.push(corridor ?? columns[columns.length - 1]);
    }

    columns.push(endPortOf(plan));

    return columns;
  };

  const runs: Run[] = [];
  const columnsFor = new Map<number, number[]>();

  for (const plan of planned) {
    const columns = columnsOf(plan);
    columnsFor.set(plan.edge, columns);

    plan.channels.forEach((channel, at) => {
      const from = columns[at];
      const to = columns[at + 1];
      runs.push({
        edge: plan.edge,
        channel,
        low: Math.min(from, to),
        high: Math.max(from, to),
      });
    });
  }

  // Lanes, channel by channel. A connector crossing several channels takes a
  // lane in each, which is what turns a long straight column into a staircase.
  const byChannel = new Map<number, Run[]>();
  for (const run of runs) {
    const list = byChannel.get(run.channel);
    if (list) {
      list.push(run);
    } else {
      byChannel.set(run.channel, [run]);
    }
  }

  const laneCount = new Map<number, number>();
  const laneOf = new Map<string, number>();

  for (const [channel, list] of byChannel) {
    const lanes = assignLanes(list);
    laneCount.set(channel, Math.max(0, ...lanes.values()) + 1);
    for (const [edge, lane] of lanes) {
      laneOf.set(`${edge}:${channel}`, lane);
    }
  }

  /** Flow position of one lane in the channel after band `channel`. */
  const laneFlow = (channel: number, lane: number): number | null => {
    const start = bandFar.get(channel);
    const end = bandNear.get(channel + 1);
    const count = laneCount.get(channel);

    if (start === undefined || end === undefined || !count) {
      return null;
    }

    const from = start + LANE_MARGIN;
    const to = end - LANE_MARGIN;

    if (to <= from) {
      // Channel too shallow to hold lanes; the elbow router can have it.
      return null;
    }

    return from + ((lane + 1) * (to - from)) / (count + 1);
  };

  const routes: PlannedRoute[] = [];

  for (const plan of planned) {
    const columns = columnsFor.get(plan.edge)!;
    const startPort = columns[0];
    const endPort = columns[columns.length - 1];

    // The stub always leaves along the direction of travel, so a connector
    // running against the flow leaves the near side and arrives at the far one.
    const startStub = plan.forward
      ? flowEnd(plan.from) + STUB
      : flowStart(plan.from) - STUB;
    const endStub = plan.forward
      ? flowStart(plan.to) - STUB
      : flowEnd(plan.to) + STUB;

    const waypoints: Point[] = [at(startStub, startPort)];

    plan.channels.forEach((channel, index) => {
      const lane = laneOf.get(`${plan.edge}:${channel}`);
      const flow = lane === undefined ? null : laneFlow(channel, lane);

      if (flow === null) {
        return;
      }

      waypoints.push(at(flow, columns[index]), at(flow, columns[index + 1]));
    });

    waypoints.push(at(endStub, endPort));

    routes.push({
      edge: plan.edge,
      // A corridor that changed nothing leaves a repeated point behind.
      waypoints: waypoints.filter(
        (point, index) =>
          index === 0 ||
          point.x !== waypoints[index - 1].x ||
          point.y !== waypoints[index - 1].y,
      ),
    });
  }

  return { routes, laneCount };
};

/**
 * Extra room each channel needs so its lanes are far enough apart to be told
 * apart, given the gap the layout would use anyway.
 *
 * Growth is capped: past a point a deeper channel costs more in scrolling than
 * it wins in clarity, and the lanes inside it simply pack tighter.
 */
export const extraGapForLanes = (
  laneCount: Map<number, number>,
  baseGap: number,
  cap = 260,
): ((band: number) => number) => {
  const extra = new Map<number, number>();

  for (const [channel, count] of laneCount) {
    const wanted = count * LANE_PITCH + LANE_MARGIN * 2;
    extra.set(channel, Math.min(cap, Math.max(0, wanted - baseGap)));
  }

  return (band: number) => extra.get(band) ?? 0;
};
