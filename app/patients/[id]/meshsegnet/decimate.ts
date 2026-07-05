// Fast decimation for MeshSegNet preprocessing: grid-based vertex
// clustering (snap nearby vertices to their cluster centroid, then drop
// degenerate triangles). three.js's own SimplifyModifier (quadric edge
// collapse) was tried first and found impractically slow for the reduction
// ratios real 3Shape scans need (~150-200k triangles down to ~10k) — it
// hung the main thread for minutes without completing in testing. This is a
// cruder decimation (no quadric-error optimization), but it's a single O(N)
// pass, and MeshSegNet has proven robust to real, very different
// decimations (3Shape/VTK's own quadric decimation already gives different
// triangle counts per patient/jaw with no quality issue) — so hitting
// exactly the same point count/topology as any particular reference is not
// required, only landing in the right ballpark.

import * as THREE from "three";

export function decimateToTargetCells(
  geometry: THREE.BufferGeometry,
  targetCells: number
): THREE.BufferGeometry {
  const posAttr = geometry.attributes.position;
  const currentCells = posAttr.count / 3;
  if (currentCells <= targetCells) return geometry;

  const targetVertices = Math.max(4, Math.round(targetCells / 2));

  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < posAttr.count; i++) {
    const x = posAttr.getX(i), y = posAttr.getY(i), z = posAttr.getZ(i);
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
  }
  // The mesh is a thin 2D shell embedded in 3D, so cluster count scales
  // with cellSize^-2 (surface area / cellSize^2), not cellSize^-3 like a
  // solid volume would — use the bounding box's surface area as the size
  // estimate instead of its volume.
  const dx = maxX - minX, dy = maxY - minY, dz = maxZ - minZ;
  const surfaceArea = Math.max(1e-6, 2 * (dx * dy + dy * dz + dx * dz));

  interface ClusterResult {
    vertexCluster: Int32Array;
    sumX: number[];
    sumY: number[];
    sumZ: number[];
    count: number[];
    nClusters: number;
  }

  const clusterOnce = (cellSize: number): ClusterResult => {
    const clusterOf = new Map<string, number>();
    const sumX: number[] = [], sumY: number[] = [], sumZ: number[] = [], count: number[] = [];
    const vertexCluster = new Int32Array(posAttr.count);
    for (let i = 0; i < posAttr.count; i++) {
      const x = posAttr.getX(i), y = posAttr.getY(i), z = posAttr.getZ(i);
      const key = `${Math.floor(x / cellSize)}_${Math.floor(y / cellSize)}_${Math.floor(z / cellSize)}`;
      let id = clusterOf.get(key);
      if (id === undefined) {
        id = sumX.length;
        clusterOf.set(key, id);
        sumX.push(0); sumY.push(0); sumZ.push(0); count.push(0);
      }
      sumX[id] += x; sumY[id] += y; sumZ[id] += z; count[id]++;
      vertexCluster[i] = id;
    }
    return { vertexCluster, sumX, sumY, sumZ, count, nClusters: sumX.length };
  };

  // Iteratively tune the grid cell size to land within +/-20% of the
  // target vertex count (cheap: each clusterOnce() pass is a single O(N)
  // scan, so a handful of retries is still far faster than edge-collapse
  // decimation was).
  let cellSize = Math.sqrt(surfaceArea / Math.max(1, targetVertices));
  let result = clusterOnce(cellSize);
  for (let attempt = 0; attempt < 8; attempt++) {
    if (result.nClusters >= targetVertices * 0.8 && result.nClusters <= targetVertices * 1.2) break;
    cellSize *= Math.sqrt(result.nClusters / targetVertices);
    result = clusterOnce(cellSize);
  }

  const { vertexCluster, sumX, sumY, sumZ, count, nClusters } = result;
  const clusterX = new Float32Array(nClusters);
  const clusterY = new Float32Array(nClusters);
  const clusterZ = new Float32Array(nClusters);
  for (let c = 0; c < nClusters; c++) {
    clusterX[c] = sumX[c] / count[c];
    clusterY[c] = sumY[c] / count[c];
    clusterZ[c] = sumZ[c] / count[c];
  }

  const outPositions: number[] = [];
  for (let t = 0; t < currentCells; t++) {
    const i0 = t * 3, i1 = i0 + 1, i2 = i0 + 2;
    const c0 = vertexCluster[i0], c1 = vertexCluster[i1], c2 = vertexCluster[i2];
    if (c0 === c1 || c1 === c2 || c0 === c2) continue; // degenerate after clustering
    outPositions.push(
      clusterX[c0], clusterY[c0], clusterZ[c0],
      clusterX[c1], clusterY[c1], clusterZ[c1],
      clusterX[c2], clusterY[c2], clusterZ[c2]
    );
  }

  const outGeometry = new THREE.BufferGeometry();
  outGeometry.setAttribute("position", new THREE.Float32BufferAttribute(outPositions, 3));
  return outGeometry;
}
