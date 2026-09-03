/**
 * System design / architecture specs.
 *
 * "Design a URL shortener" and "draw our microservice architecture" are not
 * abstract-things-connected-to-abstract-things: they have a vocabulary of their
 * own — load balancers, caches, queues, databases — and a natural reading
 * order, clients at the edge and data stores at the back. A generic diagram
 * flattens all of that into identical rectangles, which is why those drawings
 * came out looking like flowcharts with database labels.
 *
 * The bargain is the same one every other kind makes: the model describes
 * structure (typed components, connections, zones), and everything geometric —
 * tiers, bands, zone boxes, connectors — is computed deterministically.
 */

/** The component vocabulary a system design draws from. */
export type SystemComponentType =
  | "client"
  | "cdn"
  | "firewall"
  | "load-balancer"
  | "gateway"
  | "service"
  | "queue"
  | "cache"
  | "database"
  | "storage"
  | "external";

export const SYSTEM_COMPONENT_TYPES: SystemComponentType[] = [
  "client",
  "cdn",
  "firewall",
  "load-balancer",
  "gateway",
  "service",
  "queue",
  "cache",
  "database",
  "storage",
  "external",
];

export interface SystemNode {
  id: string;
  label: string;
  type: SystemComponentType;
  /**
   * Explicit tier override, 0 = front-most band. Absent means "derive from the
   * component type", which is right almost always.
   */
  tier?: number;
}

export interface SystemEdge {
  from: string;
  to: string;
  label: string;
  /** Dashed for async or optional relationships, e.g. events onto a queue. */
  dashed: boolean;
}

/**
 * A named group box drawn behind its members — "VPC", "CDN edge", "third-party".
 * Members are node ids; containment must not straddle disjoint regions, so the
 * parser validates that zones stay disjoint.
 */
export interface SystemZone {
  id: string;
  label: string;
  contains: string[];
}

export interface SystemSpec {
  /**
   * Flow direction for the tier bands: top-to-bottom or left-to-right.
   *
   * Absent when the reply did not ask for one, which is the usual case. The
   * builder then picks whichever way round gives the better-shaped picture, so
   * a wide design is not forced into a tall column — see `pickDirection`.
   */
  direction?: "down" | "right";
  nodes: SystemNode[];
  edges: SystemEdge[];
  zones: SystemZone[];
}

export const MAX_SYSTEM_NODES = 40;
export const MAX_SYSTEM_EDGES = 80;
export const MAX_ZONES = 6;

const asString = (value: unknown, fallback = ""): string =>
  typeof value === "string" ? value : fallback;

const asBoolean = (value: unknown, fallback = false): boolean =>
  typeof value === "boolean" ? value : fallback;

const trimLabel = (value: unknown): string =>
  asString(value).replace(/\s+/g, " ").trim().slice(0, 60);

/**
 * Free models ignore json_schema enums and invent types ("webserver", "DB").
 * Rather than dropping the node, map what we recognise and fall back to a
 * generic service — a drawing with an approximate type beats no drawing.
 */
const asComponentType = (value: unknown): SystemComponentType => {
  if (typeof value !== "string") {
    return "service";
  }

  const normalised = value.trim().toLowerCase().replace(/[\s_]+/g, "-");

  if ((SYSTEM_COMPONENT_TYPES as string[]).includes(normalised)) {
    return normalised as SystemComponentType;
  }

  // Common synonyms the model reaches for.
  const aliases: Record<string, SystemComponentType> = {
    webserver: "service",
    server: "service",
    api: "service",
    microservice: "service",
    app: "service",
    worker: "service",
    db: "database",
    postgres: "database",
    mysql: "database",
    redis: "cache",
    memcached: "cache",
    kafka: "queue",
    rabbitmq: "queue",
    sqs: "queue",
    bucket: "storage",
    s3: "storage",
    lb: "load-balancer",
    balancer: "load-balancer",
    proxy: "gateway",
    router: "gateway",
    browser: "client",
    user: "client",
    mobile: "client",
    waf: "firewall",
    thirdparty: "external",
    "third-party": "external",
  };

  return aliases[normalised] ?? "service";
};

/** Default tier per component type: front of the request path to back. */
export const DEFAULT_TIERS: Record<SystemComponentType, number> = {
  client: 0,
  cdn: 1,
  firewall: 1,
  "load-balancer": 2,
  gateway: 2,
  service: 3,
  queue: 4,
  cache: 4,
  database: 5,
  storage: 5,
  external: 5,
};

/**
 * Turn whatever the model returned into a system spec that is safe to lay out:
 * ids unique and non-empty, edges pointing at nodes that exist, zones whose
 * members exist and do not overlap each other's membership, within caps.
 *
 * Returns `null` only when there is nothing usable at all.
 */
export const parseSystemSpec = (input: unknown): SystemSpec | null => {
  if (!input || typeof input !== "object") {
    return null;
  }

  const raw = input as Record<string, unknown>;
  const rawNodes = Array.isArray(raw.nodes) ? raw.nodes : [];

  const nodes: SystemNode[] = [];
  const seenIds = new Set<string>();

  for (const candidate of rawNodes) {
    if (
      nodes.length >= MAX_SYSTEM_NODES ||
      !candidate ||
      typeof candidate !== "object"
    ) {
      continue;
    }

    const node = candidate as Record<string, unknown>;
    const label = trimLabel(node.label);

    let id = asString(node.id).trim() || label || `n${nodes.length + 1}`;

    if (seenIds.has(id)) {
      let suffix = 2;
      while (seenIds.has(`${id}-${suffix}`)) {
        suffix += 1;
      }
      id = `${id}-${suffix}`;
    }

    seenIds.add(id);

    const rawTier = node.tier;
    const tier =
      typeof rawTier === "number" && Number.isFinite(rawTier)
        ? Math.max(0, Math.min(5, Math.floor(rawTier)))
        : undefined;

    nodes.push({
      id,
      label: label || id,
      type: asComponentType(node.type),
      ...(tier !== undefined ? { tier } : {}),
    });
  }

  if (nodes.length === 0) {
    return null;
  }

  const rawEdges = Array.isArray(raw.edges) ? raw.edges : [];
  const edges: SystemEdge[] = [];
  const seenEdges = new Set<string>();

  for (const candidate of rawEdges) {
    if (
      edges.length >= MAX_SYSTEM_EDGES ||
      !candidate ||
      typeof candidate !== "object"
    ) {
      continue;
    }

    const edge = candidate as Record<string, unknown>;
    const from = asString(edge.from).trim();
    const to = asString(edge.to).trim();

    if (!seenIds.has(from) || !seenIds.has(to) || from === to) {
      continue;
    }

    const signature = `${from}->${to}`;
    if (seenEdges.has(signature)) {
      continue;
    }

    seenEdges.add(signature);
    edges.push({
      from,
      to,
      label: trimLabel(edge.label),
      dashed: asBoolean(edge.dashed),
    });
  }

  const rawZones = Array.isArray(raw.zones) ? raw.zones : [];
  const zones: SystemZone[] = [];
  const assigned = new Map<string, string>();

  for (const candidate of rawZones) {
    if (zones.length >= MAX_ZONES || !candidate || typeof candidate !== "object") {
      continue;
    }

    const zone = candidate as Record<string, unknown>;
    const id = asString(zone.id).trim() || `z${zones.length + 1}`;
    const contains: string[] = [];

    const rawContains = Array.isArray(zone.contains) ? zone.contains : [];
    for (const member of rawContains) {
      const memberId = asString(member).trim();
      // A node belongs to at most one zone; first claim wins, duplicates drop.
      if (
        seenIds.has(memberId) &&
        !assigned.has(memberId) &&
        !contains.includes(memberId)
      ) {
        contains.push(memberId);
        assigned.set(memberId, id);
      }
    }

    // A zone with nothing in it would render as an empty rectangle.
    if (contains.length > 0) {
      zones.push({
        id,
        label: trimLabel(zone.label) || id,
        contains,
      });
    }
  }

  return {
    // Left undefined unless the reply actually stated one: "unstated" and
    // "down" have to stay distinguishable, or every design is drawn downward.
    direction:
      raw.direction === "right" || raw.direction === "down"
        ? raw.direction
        : undefined,
    nodes,
    edges,
    zones,
  };
};
