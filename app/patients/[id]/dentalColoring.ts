// Approximates a tooth/gum color split on a scanned dental-arch mesh using
// only its geometry — no AI segmentation, no per-tooth labels. This is a
// fallback for the common case where a 3Shape export contains bare STL
// geometry with no vertex-color or texture information at all.
//
// Three cheap, purely-geometric signals are combined per vertex:
//
// - Height within its local arch slice ("hauteur" / "ligne cervicale"):
//   the mesh is bucketed into angular slices around the arch's horizontal
//   centroid; within each slice, vertices near the top of that slice are
//   more likely tooth, vertices near the bottom are more likely gum. This
//   follows the scalloped cervical line instead of applying one global
//   height cutoff, which would ignore the arch's curvature.
// - Signed curvature ("courbure"): a discrete mean-curvature-normal
//   estimate — each vertex compared to the centroid of the other corners
//   of every triangle touching it. Convex bulges (cusps, incisal edges,
//   crown contours) skew toward tooth; concave valleys (interdental
//   papillae, the gingival sulcus) skew toward gum.
// - Normal orientation ("orientation des normales"): faces whose (locally
//   averaged) normal points toward the occlusal direction skew toward
//   tooth; faces pointing away/down, as the vestibular gum surface does,
//   skew toward gum.
//
// The blended score is smoothstepped rather than thresholded, so the
// tooth/gum boundary reads as a soft gradient (like a real cervical
// margin) instead of a hard seam.
//
// Coordinate assumption: this mirrors the fixed `rotation={[-Math.PI/2, 0,
// 0]}` already applied to every JawMesh — i.e. the raw STL data is Z-up
// (Z = occlusal/incisal <-> gingival axis), which is why that rotation
// exists in the first place. X/Y are the horizontal plane the arch curves
// through.

import * as THREE from "three";

export interface DentalColorOptions {
  toothColor?: THREE.ColorRepresentation;
  gumColor?: THREE.ColorRepresentation;
  /** Number of angular slices used to estimate local (per-arch-segment) height. */
  archBuckets?: number;
}

const DEFAULT_ARCH_BUCKETS = 48;

export function applyProceduralDentalColors(
  geometry: THREE.BufferGeometry,
  options: DentalColorOptions = {}
): void {
  const position = geometry.getAttribute("position");
  const vertexCount = position.count;
  if (vertexCount === 0) return;

  const toothColor = new THREE.Color(options.toothColor ?? "#f4ecd9");
  const gumColor = new THREE.Color(options.gumColor ?? "#e3a39a");
  const bucketCount = options.archBuckets ?? DEFAULT_ARCH_BUCKETS;
  const triCount = vertexCount / 3;

  const px = new Float32Array(vertexCount);
  const py = new Float32Array(vertexCount);
  const pz = new Float32Array(vertexCount);
  const faceNormalX = new Float32Array(triCount);
  const faceNormalY = new Float32Array(triCount);
  const faceNormalZ = new Float32Array(triCount);

  let cx = 0;
  let cy = 0;

  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const edge1 = new THREE.Vector3();
  const edge2 = new THREE.Vector3();
  const normal = new THREE.Vector3();

  // Pass 1: cache positions in plain typed arrays and compute one face
  // normal per triangle (independent of the smoothed vertex normals three.js
  // already produced, since we need the raw per-face value to detect creases).
  for (let t = 0; t < triCount; t++) {
    const i0 = t * 3;
    const i1 = i0 + 1;
    const i2 = i0 + 2;
    a.fromBufferAttribute(position, i0);
    b.fromBufferAttribute(position, i1);
    c.fromBufferAttribute(position, i2);
    edge1.subVectors(b, a);
    edge2.subVectors(c, a);
    normal.crossVectors(edge1, edge2).normalize();
    faceNormalX[t] = normal.x;
    faceNormalY[t] = normal.y;
    faceNormalZ[t] = normal.z;

    px[i0] = a.x; py[i0] = a.y; pz[i0] = a.z;
    px[i1] = b.x; py[i1] = b.y; pz[i1] = b.z;
    px[i2] = c.x; py[i2] = c.y; pz[i2] = c.z;

    cx += a.x + b.x + c.x;
    cy += a.y + b.y + c.y;
  }
  cx /= vertexCount;
  cy /= vertexCount;

  // Pass 2: group the (non-indexed) vertices that share a position — STL
  // triangles emit exact-duplicate coordinates at shared edges — to recover
  // an approximate one-ring neighbourhood per mesh vertex without a full
  // half-edge structure.
  interface Group {
    indices: number[];
    sumNormalX: number;
    sumNormalY: number;
    sumNormalZ: number;
    sumOtherX: number;
    sumOtherY: number;
    sumOtherZ: number;
    otherCount: number;
  }
  const groups = new Map<string, Group>();
  const quantize = (v: number) => Math.round(v * 1000); // 1/1000 mesh-unit (µm at mm scale)

  for (let t = 0; t < triCount; t++) {
    const tri = [t * 3, t * 3 + 1, t * 3 + 2];
    for (let k = 0; k < 3; k++) {
      const i = tri[k];
      const key = `${quantize(px[i])}_${quantize(py[i])}_${quantize(pz[i])}`;
      let group = groups.get(key);
      if (!group) {
        group = {
          indices: [],
          sumNormalX: 0,
          sumNormalY: 0,
          sumNormalZ: 0,
          sumOtherX: 0,
          sumOtherY: 0,
          sumOtherZ: 0,
          otherCount: 0,
        };
        groups.set(key, group);
      }
      group.indices.push(i);
      group.sumNormalX += faceNormalX[t];
      group.sumNormalY += faceNormalY[t];
      group.sumNormalZ += faceNormalZ[t];
      for (let o = 0; o < 3; o++) {
        if (o === k) continue;
        const j = tri[o];
        group.sumOtherX += px[j];
        group.sumOtherY += py[j];
        group.sumOtherZ += pz[j];
        group.otherCount++;
      }
    }
  }

  const curvature = new Float32Array(vertexCount);
  const normalZ = new Float32Array(vertexCount);
  let curvatureAbsSum = 0;

  for (const group of groups.values()) {
    const meanNormal = new THREE.Vector3(
      group.sumNormalX,
      group.sumNormalY,
      group.sumNormalZ
    );
    if (meanNormal.lengthSq() < 1e-12) meanNormal.set(0, 0, 1);
    meanNormal.normalize();

    const neighborCentroid =
      group.otherCount > 0
        ? new THREE.Vector3(
            group.sumOtherX / group.otherCount,
            group.sumOtherY / group.otherCount,
            group.sumOtherZ / group.otherCount
          )
        : null;

    for (const i of group.indices) {
      normalZ[i] = meanNormal.z;
      if (neighborCentroid) {
        // Signed distance of this vertex from its neighbourhood, measured
        // along the surface normal: positive = convex bulge (cusp/ridge),
        // negative = concave valley (papilla/sulcus/cervical margin).
        const dx = px[i] - neighborCentroid.x;
        const dy = py[i] - neighborCentroid.y;
        const dz = pz[i] - neighborCentroid.z;
        const c0 =
          dx * meanNormal.x + dy * meanNormal.y + dz * meanNormal.z;
        curvature[i] = c0;
        curvatureAbsSum += Math.abs(c0);
      }
    }
  }

  const curvatureScale = Math.max(curvatureAbsSum / vertexCount, 1e-6) * 3;

  // Pass 3: bucket vertices angularly around the arch centroid and track
  // the min/max height (Z) seen in each bucket, so "height" is measured
  // relative to the local cross-section of the arch rather than its whole
  // bounding box.
  const bucketMin = new Float32Array(bucketCount).fill(Infinity);
  const bucketMax = new Float32Array(bucketCount).fill(-Infinity);
  const bucketCounts = new Int32Array(bucketCount);
  const bucketOf = new Int32Array(vertexCount);

  let globalMinZ = Infinity;
  let globalMaxZ = -Infinity;

  for (let i = 0; i < vertexCount; i++) {
    const angle = Math.atan2(py[i] - cy, px[i] - cx);
    const bucket = Math.min(
      bucketCount - 1,
      Math.max(0, Math.floor(((angle + Math.PI) / (2 * Math.PI)) * bucketCount))
    );
    bucketOf[i] = bucket;
    const z = pz[i];
    if (z < bucketMin[bucket]) bucketMin[bucket] = z;
    if (z > bucketMax[bucket]) bucketMax[bucket] = z;
    bucketCounts[bucket]++;
    if (z < globalMinZ) globalMinZ = z;
    if (z > globalMaxZ) globalMaxZ = z;
  }

  const globalRange = Math.max(globalMaxZ - globalMinZ, 1e-6);

  // Pass 4: combine the three signals into a 0..1 "toothness" score per
  // vertex and write the blended ivory/gum color.
  const colors = new Float32Array(vertexCount * 3);
  const blendedColor = new THREE.Color();

  for (let i = 0; i < vertexCount; i++) {
    const bucket = bucketOf[i];
    // Sparse buckets (few samples on a thin sliver of the arch) give a
    // noisy min/max; fall back to the whole arch's height range for those.
    const useLocalBucket =
      bucketCounts[bucket] >= 6 &&
      bucketMax[bucket] - bucketMin[bucket] > globalRange * 0.05;
    const lo = useLocalBucket ? bucketMin[bucket] : globalMinZ;
    const hi = useLocalBucket ? bucketMax[bucket] : globalMaxZ;
    const heightScore = THREE.MathUtils.clamp(
      (pz[i] - lo) / Math.max(hi - lo, 1e-6),
      0,
      1
    );

    const curvatureScore = THREE.MathUtils.clamp(
      curvature[i] / curvatureScale * 0.5 + 0.5,
      0,
      1
    );
    const normalScore = THREE.MathUtils.clamp(normalZ[i] * 0.5 + 0.5, 0, 1);

    const toothness =
      0.55 * heightScore + 0.25 * curvatureScore + 0.2 * normalScore;

    // Soft gradient around the cervical margin instead of a hard cutoff.
    const t = THREE.MathUtils.smoothstep(toothness, 0.34, 0.52);

    blendedColor.copy(gumColor).lerp(toothColor, t);
    // A touch of deterministic per-vertex variation avoids the flat,
    // plasticky look of a perfectly uniform procedural fill.
    const jitter = (((i * 2654435761) % 1000) / 1000 - 0.5) * 0.04;
    blendedColor.offsetHSL(0, 0, jitter);

    colors[i * 3] = blendedColor.r;
    colors[i * 3 + 1] = blendedColor.g;
    colors[i * 3 + 2] = blendedColor.b;
  }

  geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
}
