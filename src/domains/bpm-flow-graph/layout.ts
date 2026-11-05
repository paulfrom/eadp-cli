import type { ResourceRecord } from "../../resource/core/client.js";
import type { GraphDraftFile } from "./draft.js";
import { resolveNodeKind } from "./node-catalog.js";

/** Geometric quality metrics for one graph draft. */
export interface GraphLayoutMetrics {
  name: string;
  nodes: number;
  /** Edges whose source and target both exist and can therefore be measured. */
  edges: number;
  /** Number of edges passing through at least one node other than their endpoints. */
  throughNodeEdges: number;
  /** Number of non-collinear crossing edge pairs, excluding pairs sharing an endpoint. */
  crossingEdges: number;
  /** Number of node pairs whose rectangles overlap with positive area. */
  overlappingNodes: number;
  width: number;
  height: number;
}

export interface GraphLayoutInspection {
  flow: string;
  graphs: GraphLayoutMetrics[];
}

type RecordValue = Record<string, unknown>;

interface Point {
  x: number;
  y: number;
}

interface Rectangle {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

interface PositionedNode {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

interface PositionedEdge {
  source: string;
  target: string;
  reverse: boolean;
}

interface LayoutNode extends PositionedNode {
  layer: number;
  centerX: number;
}

interface GeometryMetrics {
  nodes: number;
  edges: number;
  throughNodeEdges: number;
  crossingEdges: number;
  overlappingNodes: number;
  width: number;
  height: number;
}

interface GeometryAnalysis {
  metrics: GeometryMetrics;
  participants: Set<string>;
}

type RepairOperation =
  | { kind: "move"; index: number; centerX: number }
  | { kind: "swap"; first: number; second: number };

const TASK_WIDTH = 160;
const TASK_HEIGHT = 80;
const EVENT_SIZE = 48;
const GATEWAY_SIZE = 64;
const HORIZONTAL_GAP = 120;
const VERTICAL_GAP = 140;
const CELL_WIDTH = TASK_WIDTH + HORIZONTAL_GAP;
const ORIGIN_X = 80;
const ORIGIN_Y = 60;
const EPSILON = 1e-7;
const MAX_REPAIR_ROUNDS = 48;

/**
 * Lay out every draft without changing the input. Non-reverse edges determine
 * top-down topological layers; nodes in one layer are arranged horizontally.
 * Only the existing designer fields `x` and `y` are written.
 */
export function layoutGraphDraftFile(file: GraphDraftFile): GraphDraftFile {
  return {
    ...file,
    graphs: file.graphs.map((draft) => {
      const graph = cloneRecord(draft.graph);
      const process = isRecord(graph.process) ? graph.process : undefined;
      const nodes = process && isRecord(process.nodes) ? process.nodes : undefined;
      if (nodes) layoutNodes(nodes);
      return { ...draft, graph };
    })
  };
}

/** Inspect node rectangles and straight source-target segments entirely locally. */
export function inspectGraphLayout(file: GraphDraftFile): GraphLayoutInspection {
  return {
    flow: file.flow,
    graphs: file.graphs.map((draft) => {
      const process = isRecord(draft.graph.process) ? draft.graph.process : undefined;
      const rawNodes = process && isRecord(process.nodes) ? process.nodes : undefined;
      if (!rawNodes) {
        return {
          name: draft.name,
          nodes: 0,
          edges: 0,
          throughNodeEdges: 0,
          crossingEdges: 0,
          overlappingNodes: 0,
          width: 0,
          height: 0
        };
      }
      const records = nodeRecords(rawNodes);
      const nodes = [...records.entries()].map(([id, node]) => {
        const size = nodeSize(node);
        return {
          id,
          x: finiteNumber(node.x) ?? 0,
          y: finiteNumber(node.y) ?? 0,
          width: size.width,
          height: size.height
        };
      });
      const edges = collectEdges(records);
      return {
        name: draft.name,
        ...analyzeGeometry(nodes, edges).metrics
      };
    })
  };
}

function layoutNodes(rawNodes: RecordValue): void {
  const records = nodeRecords(rawNodes);
  const ids = [...records.keys()];
  if (ids.length === 0) return;
  const edges = collectEdges(records);
  const layerById = topologicalLayers(ids, edges);
  const layerCount = Math.max(...layerById.values()) + 1;
  const layers: string[][] = Array.from({ length: layerCount }, () => []);
  for (const id of ids) layers[layerById.get(id)!]!.push(id);
  orderLayers(layers, edges);

  const nodes: LayoutNode[] = [];
  const nodeById = new Map<string, LayoutNode>();
  const layerTops: number[] = [];
  let nextY = 0;
  for (let layer = 0; layer < layers.length; layer += 1) {
    const layerNodes = layers[layer]!;
    const maxHeight = Math.max(...layerNodes.map((id) => nodeSize(records.get(id)!).height));
    layerTops.push(nextY);
    nextY += maxHeight + VERTICAL_GAP;
    for (const [index, id] of layerNodes.entries()) {
      const size = nodeSize(records.get(id)!);
      const centerX = (index - (layerNodes.length - 1) / 2) * CELL_WIDTH;
      const node: LayoutNode = {
        id,
        x: centerX - size.width / 2,
        y: layerTops[layer]!,
        width: size.width,
        height: size.height,
        layer,
        centerX
      };
      nodes.push(node);
      nodeById.set(id, node);
    }
  }

  repairLayout(nodes, edges);
  const minX = Math.min(...nodes.map((node) => node.x));
  const minY = Math.min(...nodes.map((node) => node.y));
  const offsetX = ORIGIN_X - minX;
  const offsetY = ORIGIN_Y - minY;
  for (const node of nodes) {
    const record = records.get(node.id)!;
    record.x = Math.round(node.x + offsetX);
    record.y = Math.round(node.y + offsetY);
  }
}

/** Longest-path layering on the forward DAG; reverse edges never affect rank. */
function topologicalLayers(ids: string[], edges: PositionedEdge[]): Map<string, number> {
  const ranks = new Map<string, number>(ids.map((id) => [id, 0]));
  const indegree = new Map<string, number>(ids.map((id) => [id, 0]));
  const outgoing = new Map<string, string[]>(ids.map((id) => [id, []]));
  for (const edge of edges) {
    if (edge.reverse || edge.source === edge.target) continue;
    outgoing.get(edge.source)!.push(edge.target);
    indegree.set(edge.target, (indegree.get(edge.target) ?? 0) + 1);
  }
  for (const targets of outgoing.values()) targets.sort(compareText);

  const ready = ids.filter((id) => indegree.get(id) === 0).sort(compareText);
  const processed = new Set<string>();
  while (ready.length > 0) {
    const id = ready.shift()!;
    processed.add(id);
    const sourceRank = ranks.get(id)!;
    for (const target of outgoing.get(id)!) {
      ranks.set(target, Math.max(ranks.get(target)!, sourceRank + 1));
      const remaining = indegree.get(target)! - 1;
      indegree.set(target, remaining);
      if (remaining === 0) {
        ready.push(target);
        ready.sort(compareText);
      }
    }
  }

  // Valid BPM drafts are acyclic after removing reverse edges. For malformed
  // cyclic input, remain deterministic and give every leftover node its own rank.
  let fallback = processed.size === 0
    ? 0
    : Math.max(...[...processed].map((id) => ranks.get(id)!)) + 1;
  for (const id of ids) {
    if (processed.has(id)) continue;
    ranks.set(id, fallback);
    fallback += 1;
  }
  return ranks;
}

/** Deterministic barycentric sweeps provide a good initial crossing-free order. */
function orderLayers(layers: string[][], edges: PositionedEdge[]): void {
  const forwardEdges = edges.filter((edge) => !edge.reverse);
  for (let sweep = 0; sweep < 10; sweep += 1) {
    const downward = sweep % 2 === 0;
    const start = downward ? 1 : layers.length - 2;
    const end = downward ? layers.length : -1;
    const step = downward ? 1 : -1;
    for (let index = start; index !== end; index += step) {
      const layer = layers[index];
      if (!layer || layer.length < 2) continue;
      const positions = layerPositions(layers);
      const oldOrder = new Map(layer.map((id, position) => [id, position]));
      const barycenters = new Map<string, number>();
      for (const id of layer) {
        const neighbors = forwardEdges.flatMap((edge) => {
          const neighbor = downward
            ? edge.target === id ? edge.source : undefined
            : edge.source === id ? edge.target : undefined;
          if (neighbor === undefined) return [];
          const position = positions.get(neighbor);
          return position === undefined ? [] : [position];
        });
        barycenters.set(id, neighbors.length === 0
          ? oldOrder.get(id)!
          : neighbors.reduce((sum, value) => sum + value, 0) / neighbors.length);
      }
      layer.sort((left, right) =>
        barycenters.get(left)! - barycenters.get(right)! ||
        oldOrder.get(left)! - oldOrder.get(right)! ||
        compareText(left, right));
    }
  }
}

function layerPositions(layers: string[][]): Map<string, number> {
  const positions = new Map<string, number>();
  for (const layer of layers) {
    for (const [index, id] of layer.entries()) positions.set(id, index);
  }
  return positions;
}

/**
 * Repair bypass edges and residual crossings by deterministic local moves.
 * Every candidate retains generous same-layer clearance. Plateau moves are
 * allowed once per coordinate signature; the best visited layout is retained.
 */
function repairLayout(nodes: LayoutNode[], edges: PositionedEdge[]): void {
  let current = analyzeGeometry(nodes, edges);
  if (violationCount(current.metrics) === 0) return;
  let bestMetrics = current.metrics;
  let bestCenters = nodes.map((node) => node.centerX);
  const visited = new Set<string>([layoutSignature(nodes)]);

  for (let round = 0; round < MAX_REPAIR_ROUNDS; round += 1) {
    const currentViolations = violationCount(current.metrics);
    if (currentViolations === 0) return;
    const participants = current.participants;
    let chosen: { operation: RepairOperation; analysis: GeometryAnalysis } | undefined;

    for (const [index, node] of nodes.entries()) {
      if (!participants.has(node.id)) continue;
      const original = node.centerX;
      for (const delta of [-4, -3, -2, -1, 1, 2, 3, 4]) {
        const centerX = original + delta * CELL_WIDTH;
        if (!hasSameLayerClearance(nodes, index, centerX)) continue;
        setCenterX(node, centerX);
        const analysis = analyzeGeometry(nodes, edges);
        const signature = layoutSignature(nodes);
        if (violationCount(analysis.metrics) <= currentViolations && !visited.has(signature)) {
          const operation: RepairOperation = { kind: "move", index, centerX };
          if (!chosen || compareGeometry(analysis.metrics, chosen.analysis.metrics) < 0) {
            chosen = { operation, analysis };
          }
        }
      }
      setCenterX(node, original);
    }

    for (let first = 0; first < nodes.length; first += 1) {
      const left = nodes[first]!;
      for (let second = first + 1; second < nodes.length; second += 1) {
        const right = nodes[second]!;
        if (left.layer !== right.layer ||
            (!participants.has(left.id) && !participants.has(right.id))) continue;
        const leftCenter = left.centerX;
        const rightCenter = right.centerX;
        setCenterX(left, rightCenter);
        setCenterX(right, leftCenter);
        const analysis = analyzeGeometry(nodes, edges);
        const signature = layoutSignature(nodes);
        if (violationCount(analysis.metrics) <= currentViolations && !visited.has(signature)) {
          const operation: RepairOperation = { kind: "swap", first, second };
          if (!chosen || compareGeometry(analysis.metrics, chosen.analysis.metrics) < 0) {
            chosen = { operation, analysis };
          }
        }
        setCenterX(left, leftCenter);
        setCenterX(right, rightCenter);
      }
    }

    if (!chosen) break;
    applyRepair(nodes, chosen.operation);
    current = chosen.analysis;
    visited.add(layoutSignature(nodes));
    if (compareGeometry(current.metrics, bestMetrics) < 0) {
      bestMetrics = current.metrics;
      bestCenters = nodes.map((node) => node.centerX);
    }
  }

  if (violationCount(current.metrics) !== 0) {
    for (const [index, node] of nodes.entries()) setCenterX(node, bestCenters[index]!);
  }
}

function applyRepair(nodes: LayoutNode[], operation: RepairOperation): void {
  if (operation.kind === "move") {
    setCenterX(nodes[operation.index]!, operation.centerX);
    return;
  }
  const first = nodes[operation.first]!;
  const second = nodes[operation.second]!;
  const center = first.centerX;
  setCenterX(first, second.centerX);
  setCenterX(second, center);
}

function hasSameLayerClearance(nodes: LayoutNode[], movingIndex: number, centerX: number): boolean {
  const moving = nodes[movingIndex]!;
  const left = centerX - moving.width / 2;
  const right = centerX + moving.width / 2;
  for (const [index, other] of nodes.entries()) {
    if (index === movingIndex || other.layer !== moving.layer) continue;
    const gap = right <= other.x
      ? other.x - right
      : other.x + other.width <= left
        ? left - other.x - other.width
        : -1;
    if (gap < HORIZONTAL_GAP - EPSILON) return false;
  }
  return true;
}

function setCenterX(node: LayoutNode, centerX: number): void {
  node.centerX = centerX;
  node.x = centerX - node.width / 2;
}

function layoutSignature(nodes: LayoutNode[]): string {
  return nodes.map((node) => `${node.id}:${node.centerX}`).join("|");
}

function compareGeometry(left: GeometryMetrics, right: GeometryMetrics): number {
  return violationCount(left) - violationCount(right) ||
    left.throughNodeEdges - right.throughNodeEdges ||
    left.crossingEdges - right.crossingEdges ||
    left.overlappingNodes - right.overlappingNodes ||
    left.width - right.width ||
    left.height - right.height;
}

function violationCount(metrics: GeometryMetrics): number {
  return metrics.throughNodeEdges + metrics.crossingEdges + metrics.overlappingNodes;
}

function analyzeGeometry(nodes: PositionedNode[], edges: PositionedEdge[]): GeometryAnalysis {
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const rectangles = new Map(nodes.map((node) => [node.id, rectangle(node)]));
  const participants = new Set<string>();
  let overlappingNodes = 0;
  for (let first = 0; first < nodes.length; first += 1) {
    const left = rectangles.get(nodes[first]!.id)!;
    for (let second = first + 1; second < nodes.length; second += 1) {
      const right = rectangles.get(nodes[second]!.id)!;
      if (rectanglesOverlap(left, right)) {
        overlappingNodes += 1;
        participants.add(nodes[first]!.id);
        participants.add(nodes[second]!.id);
      }
    }
  }

  let throughNodeEdges = 0;
  for (const edge of edges) {
    const source = nodeById.get(edge.source)!;
    const target = nodeById.get(edge.target)!;
    const start = center(source);
    const end = center(target);
    if (samePoint(start, end)) continue;
    let through = false;
    for (const node of nodes) {
      if (node.id === edge.source || node.id === edge.target) continue;
      if (segmentThroughRectangle(start, end, rectangles.get(node.id)!)) {
        through = true;
        participants.add(edge.source);
        participants.add(edge.target);
        participants.add(node.id);
      }
    }
    if (through) throughNodeEdges += 1;
  }

  let crossingEdges = 0;
  for (let first = 0; first < edges.length; first += 1) {
    const left = edges[first]!;
    for (let second = first + 1; second < edges.length; second += 1) {
      const right = edges[second]!;
      if (left.source === right.source || left.source === right.target ||
          left.target === right.source || left.target === right.target) continue;
      const leftStart = center(nodeById.get(left.source)!);
      const leftEnd = center(nodeById.get(left.target)!);
      const rightStart = center(nodeById.get(right.source)!);
      const rightEnd = center(nodeById.get(right.target)!);
      if (segmentsCross(leftStart, leftEnd, rightStart, rightEnd)) {
        crossingEdges += 1;
        participants.add(left.source);
        participants.add(left.target);
        participants.add(right.source);
        participants.add(right.target);
      }
    }
  }

  const width = nodes.length === 0
    ? 0
    : Math.max(...nodes.map((node) => node.x + node.width)) - Math.min(...nodes.map((node) => node.x));
  const height = nodes.length === 0
    ? 0
    : Math.max(...nodes.map((node) => node.y + node.height)) - Math.min(...nodes.map((node) => node.y));
  return {
    metrics: {
      nodes: nodes.length,
      edges: edges.length,
      throughNodeEdges,
      crossingEdges,
      overlappingNodes,
      width,
      height
    },
    participants
  };
}

function nodeRecords(rawNodes: RecordValue): Map<string, RecordValue> {
  const records = new Map<string, RecordValue>();
  for (const key of Object.keys(rawNodes).sort(compareText)) {
    const node = rawNodes[key];
    if (isRecord(node)) records.set(key, node);
  }
  return records;
}

function collectEdges(records: Map<string, RecordValue>): PositionedEdge[] {
  const edges: PositionedEdge[] = [];
  for (const [source, node] of records) {
    if (!Array.isArray(node.target)) continue;
    for (const rawTarget of node.target) {
      if (!isRecord(rawTarget) || typeof rawTarget.targetId !== "string") continue;
      const target = rawTarget.targetId.trim();
      if (!records.has(target)) continue;
      edges.push({ source, target, reverse: edgeIsReverse(rawTarget) });
    }
  }
  return edges;
}

function edgeIsReverse(target: RecordValue): boolean {
  let uel = target.uel;
  if (typeof uel === "string" && uel.trim() !== "") {
    try {
      uel = JSON.parse(uel) as unknown;
    } catch {
      return false;
    }
  }
  return isRecord(uel) && (uel.isReverse === true || uel.isReverse === "true");
}

function nodeSize(node: RecordValue): { width: number; height: number } {
  const group = resolveNodeKind(node).rule?.group;
  if (group === "event") return { width: EVENT_SIZE, height: EVENT_SIZE };
  if (group === "gateway") return { width: GATEWAY_SIZE, height: GATEWAY_SIZE };
  return { width: TASK_WIDTH, height: TASK_HEIGHT };
}

function rectangle(node: PositionedNode): Rectangle {
  return {
    left: node.x,
    top: node.y,
    right: node.x + node.width,
    bottom: node.y + node.height
  };
}

function center(node: PositionedNode): Point {
  return { x: node.x + node.width / 2, y: node.y + node.height / 2 };
}

function rectanglesOverlap(left: Rectangle, right: Rectangle): boolean {
  return left.left < right.right - EPSILON && left.right > right.left + EPSILON &&
    left.top < right.bottom - EPSILON && left.bottom > right.top + EPSILON;
}

/** Liang-Barsky clipping, followed by a strict-interior check at the midpoint. */
function segmentThroughRectangle(start: Point, end: Point, rectangle: Rectangle): boolean {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  let enter = 0;
  let exit = 1;
  const clips: Array<[number, number]> = [
    [-dx, start.x - rectangle.left],
    [dx, rectangle.right - start.x],
    [-dy, start.y - rectangle.top],
    [dy, rectangle.bottom - start.y]
  ];
  for (const [p, q] of clips) {
    if (Math.abs(p) <= EPSILON) {
      if (q < 0) return false;
      continue;
    }
    const ratio = q / p;
    if (p < 0) enter = Math.max(enter, ratio);
    else exit = Math.min(exit, ratio);
    if (enter - exit > EPSILON) return false;
  }
  if (exit - enter <= EPSILON) return false;
  const middle = (enter + exit) / 2;
  const x = start.x + middle * dx;
  const y = start.y + middle * dy;
  return x > rectangle.left + EPSILON && x < rectangle.right - EPSILON &&
    y > rectangle.top + EPSILON && y < rectangle.bottom - EPSILON;
}

/** Parallel and collinear segments are deliberately not crossings. */
function segmentsCross(a: Point, b: Point, c: Point, d: Point): boolean {
  if (samePoint(a, b) || samePoint(c, d)) return false;
  const rx = b.x - a.x;
  const ry = b.y - a.y;
  const sx = d.x - c.x;
  const sy = d.y - c.y;
  const denominator = cross(rx, ry, sx, sy);
  if (Math.abs(denominator) <= EPSILON) return false;
  const qpx = c.x - a.x;
  const qpy = c.y - a.y;
  const t = cross(qpx, qpy, sx, sy) / denominator;
  const u = cross(qpx, qpy, rx, ry) / denominator;
  return t >= -EPSILON && t <= 1 + EPSILON && u >= -EPSILON && u <= 1 + EPSILON;
}

function cross(ax: number, ay: number, bx: number, by: number): number {
  return ax * by - ay * bx;
}

function samePoint(left: Point, right: Point): boolean {
  return Math.abs(left.x - right.x) <= EPSILON && Math.abs(left.y - right.y) <= EPSILON;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function cloneRecord(value: ResourceRecord): ResourceRecord {
  return cloneUnknown(value) as ResourceRecord;
}

function cloneUnknown(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(cloneUnknown);
  if (!isRecord(value)) return value;
  const result: RecordValue = {};
  for (const [key, child] of Object.entries(value)) result[key] = cloneUnknown(child);
  return result;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isRecord(value: unknown): value is RecordValue {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
