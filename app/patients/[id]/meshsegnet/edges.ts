// Mesh-adjacency smoothness edges for the graph-cut refinement step: two
// cells are adjacent if they share exactly 2 vertices, weighted by the
// angle between their normals and the distance between their barycenters
// — the same formula the official MeshSegNet post-processing script uses.

import * as THREE from "three";

export interface SmoothnessEdge {
  a: number;
  b: number;
  w: number;
}

export function buildPairwiseEdges(
  nCells: number,
  normalX: Float64Array,
  normalY: Float64Array,
  normalZ: Float64Array,
  bx: Float64Array,
  by: Float64Array,
  bz: Float64Array,
  posAttr: THREE.BufferAttribute | THREE.InterleavedBufferAttribute,
  lambdaC = 30,
  roundFactor = 100
): SmoothnessEdge[] {
  // Group the (non-indexed) triangle corners by quantized position to
  // recover which cells share a mesh vertex (same technique used in
  // dentalColoring.ts's curvature estimate).
  const quantize = (v: number) => Math.round(v * 1000);
  const groups = new Map<string, number[]>();
  for (let t = 0; t < nCells; t++) {
    for (let k = 0; k < 3; k++) {
      const i = t * 3 + k;
      const key = `${quantize(posAttr.getX(i))}_${quantize(posAttr.getY(i))}_${quantize(posAttr.getZ(i))}`;
      let g = groups.get(key);
      if (!g) { g = []; groups.set(key, g); }
      g.push(t);
    }
  }

  const sharedCount = new Map<string, number>();
  for (const cellsAtVertex of groups.values()) {
    const unique = Array.from(new Set(cellsAtVertex));
    for (let a = 0; a < unique.length; a++) {
      for (let b = a + 1; b < unique.length; b++) {
        const u = Math.min(unique[a], unique[b]);
        const v = Math.max(unique[a], unique[b]);
        const key = `${u}_${v}`;
        sharedCount.set(key, (sharedCount.get(key) || 0) + 1);
      }
    }
  }

  const edges: SmoothnessEdge[] = [];
  for (const [key, count] of sharedCount.entries()) {
    if (count !== 2) continue;
    const [aStr, bStr] = key.split("_");
    const a = Number(aStr), b = Number(bStr);

    const nax = normalX[a], nay = normalY[a], naz = normalZ[a];
    const nbx = normalX[b], nby = normalY[b], nbz = normalZ[b];
    const na = Math.hypot(nax, nay, naz), nb = Math.hypot(nbx, nby, nbz);
    let cosTheta = (nax * nbx + nay * nby + naz * nbz) / (na * nb);
    if (cosTheta >= 1.0) cosTheta = 0.9999;
    const theta = Math.acos(cosTheta);
    const phi = Math.hypot(bx[a] - bx[b], by[a] - by[b], bz[a] - bz[b]);

    let weight: number;
    if (theta > Math.PI / 2) {
      weight = -Math.log10(theta / Math.PI) * phi;
    } else {
      const beta = 1 + Math.abs(nax * nbx + nay * nby + naz * nbz);
      weight = -beta * Math.log10(theta / Math.PI) * phi;
    }
    edges.push({ a, b, w: weight * lambdaC * roundFactor });
  }
  return edges;
}
