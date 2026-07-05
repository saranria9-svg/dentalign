// Feature/adjacency preprocessing for MeshSegNet inference, matching the
// official Python pipeline's predict() step exactly: per-cell normals and
// barycenters, feature normalization, and the two dense adjacency matrices
// (A_S short-range, A_L long-range) its graph-constrained learning modules
// need.

import * as THREE from "three";

export interface FeaturesAndAdjacency {
  /** [nCells, 15] feature matrix, row-major. */
  X: Float32Array;
  /** [nCells, nCells] short-range adjacency, row-major. */
  A_S: Float32Array;
  /** [nCells, nCells] long-range adjacency, row-major. */
  A_L: Float32Array;
  nCells: number;
  normalX: Float64Array;
  normalY: Float64Array;
  normalZ: Float64Array;
  bx: Float64Array;
  by: Float64Array;
  bz: Float64Array;
}

function mean(arr: ArrayLike<number>): number {
  let s = 0;
  for (let i = 0; i < arr.length; i++) s += arr[i];
  return s / arr.length;
}
function std(arr: ArrayLike<number>, m: number): number {
  let s = 0;
  for (let i = 0; i < arr.length; i++) s += (arr[i] - m) ** 2;
  return Math.sqrt(s / arr.length);
}

export function buildFeaturesAndAdjacency(geometry: THREE.BufferGeometry): FeaturesAndAdjacency {
  const posAttr = geometry.attributes.position; // non-indexed: 3 verts per cell
  const nCells = posAttr.count / 3;

  const px = new Float64Array(posAttr.count);
  const py = new Float64Array(posAttr.count);
  const pz = new Float64Array(posAttr.count);
  let cx = 0, cy = 0, cz = 0;
  for (let i = 0; i < posAttr.count; i++) {
    px[i] = posAttr.getX(i); py[i] = posAttr.getY(i); pz[i] = posAttr.getZ(i);
    cx += px[i]; cy += py[i]; cz += pz[i];
  }
  cx /= posAttr.count; cy /= posAttr.count; cz /= posAttr.count;
  for (let i = 0; i < posAttr.count; i++) { px[i] -= cx; py[i] -= cy; pz[i] -= cz; }

  const normalX = new Float64Array(nCells);
  const normalY = new Float64Array(nCells);
  const normalZ = new Float64Array(nCells);
  const bx = new Float64Array(nCells);
  const by = new Float64Array(nCells);
  const bz = new Float64Array(nCells);
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  const e1 = new THREE.Vector3(), e2 = new THREE.Vector3(), n = new THREE.Vector3();
  for (let t = 0; t < nCells; t++) {
    const i0 = t * 3, i1 = i0 + 1, i2 = i0 + 2;
    a.set(px[i0], py[i0], pz[i0]);
    b.set(px[i1], py[i1], pz[i1]);
    c.set(px[i2], py[i2], pz[i2]);
    e1.subVectors(b, a); e2.subVectors(c, a);
    n.crossVectors(e1, e2).normalize();
    normalX[t] = n.x; normalY[t] = n.y; normalZ[t] = n.z;
    bx[t] = (a.x + b.x + c.x) / 3;
    by[t] = (a.y + b.y + c.y) / 3;
    bz[t] = (a.z + b.z + c.z) / 3;
  }

  const meanX = mean(px), meanY = mean(py), meanZ = mean(pz);
  const stdX = std(px, meanX), stdY = std(py, meanY), stdZ = std(pz, meanZ);
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (let t = 0; t < nCells; t++) {
    if (bx[t] < minX) minX = bx[t]; if (bx[t] > maxX) maxX = bx[t];
    if (by[t] < minY) minY = by[t]; if (by[t] > maxY) maxY = by[t];
    if (bz[t] < minZ) minZ = bz[t]; if (bz[t] > maxZ) maxZ = bz[t];
  }
  const nMeanX = mean(normalX), nMeanY = mean(normalY), nMeanZ = mean(normalZ);
  const nStdX = std(normalX, nMeanX), nStdY = std(normalY, nMeanY), nStdZ = std(normalZ, nMeanZ);

  const X = new Float32Array(nCells * 15);
  for (let t = 0; t < nCells; t++) {
    const i0 = t * 3, i1 = i0 + 1, i2 = i0 + 2;
    const row = t * 15;
    X[row + 0] = (px[i0] - meanX) / stdX; X[row + 1] = (py[i0] - meanY) / stdY; X[row + 2] = (pz[i0] - meanZ) / stdZ;
    X[row + 3] = (px[i1] - meanX) / stdX; X[row + 4] = (py[i1] - meanY) / stdY; X[row + 5] = (pz[i1] - meanZ) / stdZ;
    X[row + 6] = (px[i2] - meanX) / stdX; X[row + 7] = (py[i2] - meanY) / stdY; X[row + 8] = (pz[i2] - meanZ) / stdZ;
    X[row + 9] = (bx[t] - minX) / (maxX - minX);
    X[row + 10] = (by[t] - minY) / (maxY - minY);
    X[row + 11] = (bz[t] - minZ) / (maxZ - minZ);
    X[row + 12] = (normalX[t] - nMeanX) / nStdX;
    X[row + 13] = (normalY[t] - nMeanY) / nStdY;
    X[row + 14] = (normalZ[t] - nMeanZ) / nStdZ;
  }

  // Dense adjacency matrices from the *normalized* (0..1) barycenter
  // columns, matching distance_matrix(X[:,9:12]) on the already
  // column-stacked+normalized feature matrix in the Python pipeline.
  const bxn = new Float64Array(nCells), byn = new Float64Array(nCells), bzn = new Float64Array(nCells);
  for (let t = 0; t < nCells; t++) {
    bxn[t] = X[t * 15 + 9]; byn[t] = X[t * 15 + 10]; bzn[t] = X[t * 15 + 11];
  }

  const A_S = new Float32Array(nCells * nCells);
  const A_L = new Float32Array(nCells * nCells);
  const rowSumS = new Float64Array(nCells);
  const rowSumL = new Float64Array(nCells);
  for (let i = 0; i < nCells; i++) {
    for (let j = 0; j < nCells; j++) {
      const dx = bxn[i] - bxn[j], dy = byn[i] - byn[j], dz = bzn[i] - bzn[j];
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (d < 0.1) { A_S[i * nCells + j] = 1; rowSumS[i]++; }
      if (d < 0.2) { A_L[i * nCells + j] = 1; rowSumL[i]++; }
    }
  }
  for (let i = 0; i < nCells; i++) {
    for (let j = 0; j < nCells; j++) {
      if (rowSumS[i] > 0) A_S[i * nCells + j] /= rowSumS[i];
      if (rowSumL[i] > 0) A_L[i * nCells + j] /= rowSumL[i];
    }
  }

  return { X, A_S, A_L, nCells, normalX, normalY, normalZ, bx, by, bz };
}
