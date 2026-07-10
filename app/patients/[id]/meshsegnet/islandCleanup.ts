// Removes small islands from the graph-cut's binary labeling: connected
// components (via the same mesh-adjacency edges used for the graph-cut's
// smoothness term) smaller than `minIslandSize` that are mostly surrounded
// by the other label get flipped to match their surroundings.
//
// The graph-cut's smoothness term already discourages small islands, but
// doesn't forbid them outright — a strong enough burst of confident-but-
// wrong unary cost (a decimated cell whose geometry genuinely looks
// ambiguous) can still carve out a small gingiva patch on a tooth crown, or
// a small tooth-colored gap in the gum. Anatomically, the tooth/gum
// boundary is one continuous curve around the arch; a handful of isolated
// cells of the "wrong" label a few millimetres from that curve is never
// correct, so snapping them to their neighbourhood's majority label is a
// safe cleanup rather than a guess.
import type { SmoothnessEdge } from "./graphcut";

export function removeSmallLabelIslands(
  numCells: number,
  labels: Uint8Array,
  edges: SmoothnessEdge[],
  minIslandSize = 40
): Uint8Array {
  const adjacency: number[][] = Array.from({ length: numCells }, () => []);
  for (const { a, b } of edges) {
    adjacency[a].push(b);
    adjacency[b].push(a);
  }

  const visited = new Uint8Array(numCells);
  const cleaned = labels.slice();

  for (let start = 0; start < numCells; start++) {
    if (visited[start]) continue;
    const label = labels[start];
    const component = [start];
    visited[start] = 1;
    let qi = 0;
    while (qi < component.length) {
      const cur = component[qi++];
      for (const neighbor of adjacency[cur]) {
        if (!visited[neighbor] && labels[neighbor] === label) {
          visited[neighbor] = 1;
          component.push(neighbor);
        }
      }
    }
    if (component.length >= minIslandSize) continue;

    // How much of this island's border touches the other label? Only flip
    // if it's genuinely surrounded (not, say, a small patch that legitimately
    // borders open space / the edge of the scan).
    let otherBorder = 0;
    let totalBorder = 0;
    for (const cell of component) {
      for (const neighbor of adjacency[cell]) {
        if (labels[neighbor] !== label) otherBorder++;
        totalBorder++;
      }
    }
    if (totalBorder > 0 && otherBorder / totalBorder > 0.5) {
      const flipped = label === 0 ? 1 : 0;
      for (const cell of component) cleaned[cell] = flipped;
    }
  }

  return cleaned;
}
