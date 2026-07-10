// Transfers a tooth/gum boundary learned on one stage's real MeshSegNet+
// graph-cut output onto every other stage's mesh — cheap enough (a
// spatial nearest-neighbour lookup, no ONNX, no decimation, no graph-cut)
// to run on every stage at import time, while reconstructing the
// reference's actual boundary shape far more faithfully than a single
// flat threshold ever could.
//
// The lookup space is (arch angle, local height fraction) rather than raw
// XYZ: real ClearAligner movement is a fraction of a millimetre per stage
// and displaces a tooth roughly within its own footprint, while the gum
// itself barely moves at all — so a query cell's own angle/height still
// lands close to where the *same* anatomical neighbourhood sits in the
// reference stage, even though the two stages don't share one absolute
// coordinate frame. A single averaged threshold per ~7.5° wedge (the
// previous approach) could only represent one flat transition line across
// an entire wedge, far coarser than the real cervical line, which scallops
// up and down with every interdental papilla and each tooth's own crown
// height — that mismatch is what read as gingiva bleeding onto some
// crowns while nearly disappearing on others. Voting among the K nearest
// of ~10,000 individually-labelled reference points reconstructs that
// real shape instead.
import { computeBucketedHeights } from "./archBuckets";

export interface ReferenceProfile {
  grid: AngleHeightGrid;
  labels: Uint8Array;
}

// A uniform grid over (angle 0..1, height 0..1), with points near the 0/1
// seam duplicated on the other side so a plain (non-circular) grid still
// finds the true nearest neighbours across the wraparound.
class AngleHeightGrid {
  angle: Float64Array;
  height: Float64Array;
  sourceIndex: Int32Array; // maps each (possibly duplicated) grid point back to its label index
  cellSize: number;
  buckets = new Map<number, number[]>();

  constructor(angleFraction: Float64Array, heightFraction: Float64Array, cellSize: number) {
    this.cellSize = cellSize;
    const n = angleFraction.length;
    const wrapMargin = Math.max(cellSize * 3, 0.05);

    const angle: number[] = [];
    const height: number[] = [];
    const sourceIndex: number[] = [];
    for (let i = 0; i < n; i++) {
      angle.push(angleFraction[i]);
      height.push(heightFraction[i]);
      sourceIndex.push(i);
      if (angleFraction[i] < wrapMargin) {
        angle.push(angleFraction[i] + 1);
        height.push(heightFraction[i]);
        sourceIndex.push(i);
      } else if (angleFraction[i] > 1 - wrapMargin) {
        angle.push(angleFraction[i] - 1);
        height.push(heightFraction[i]);
        sourceIndex.push(i);
      }
    }
    this.angle = Float64Array.from(angle);
    this.height = Float64Array.from(height);
    this.sourceIndex = Int32Array.from(sourceIndex);

    for (let i = 0; i < this.angle.length; i++) {
      const key = this.cellKey(this.angle[i], this.height[i]);
      let arr = this.buckets.get(key);
      if (!arr) { arr = []; this.buckets.set(key, arr); }
      arr.push(i);
    }
  }

  private coord(v: number): number {
    return Math.floor(v / this.cellSize);
  }
  private keyFromCoords(cx: number, cy: number): number {
    return (cx + 131072) * 262144 + (cy + 131072);
  }
  private cellKey(a: number, h: number): number {
    return this.keyFromCoords(this.coord(a), this.coord(h));
  }

  /** Indices (into the original, non-duplicated label array) of the k nearest points. */
  kNearestSourceIndices(a: number, h: number, k: number): number[] {
    const cx0 = this.coord(a), cy0 = this.coord(h);
    let radius = 1;
    let candidates: number[] = [];
    while (candidates.length < k && radius < 50) {
      candidates = [];
      for (let dx = -radius; dx <= radius; dx++) {
        for (let dy = -radius; dy <= radius; dy++) {
          const arr = this.buckets.get(this.keyFromCoords(cx0 + dx, cy0 + dy));
          if (arr) candidates.push(...arr);
        }
      }
      radius++;
    }
    candidates.sort((i, j) => {
      const di = (this.angle[i] - a) ** 2 + (this.height[i] - h) ** 2;
      const dj = (this.angle[j] - a) ** 2 + (this.height[j] - h) ** 2;
      return di - dj;
    });
    return candidates.slice(0, k).map((i) => this.sourceIndex[i]);
  }
}

/**
 * Learns the profile from one stage's decimated cells + the tooth(1)/
 * gingiva(0) labels MeshSegNet+graph-cut produced for them.
 */
export function calibrateGumProfile(
  bx: Float64Array,
  by: Float64Array,
  bz: Float64Array,
  labels: Uint8Array,
  bucketCount = 180
): ReferenceProfile {
  const { angleFraction, heightFraction } = computeBucketedHeights(bx, by, bz, bucketCount);
  // ~10,000 reference cells spread over a 0..1 x 0..1 space: a cell size
  // around 1/60 keeps a handful of points per cell (fine enough to track
  // individual teeth, coarse enough that neighbour search stays cheap).
  const grid = new AngleHeightGrid(angleFraction, heightFraction, 1 / 60);
  return { grid, labels };
}

/**
 * Classifies any other stage's cells by K-nearest-neighbour majority vote
 * against the profile — cheap enough to run on the full-resolution mesh
 * directly for every stage at import time.
 */
export function classifyByGumProfile(
  bx: Float64Array,
  by: Float64Array,
  bz: Float64Array,
  profile: ReferenceProfile,
  k = 9
): Uint8Array {
  const { angleFraction, heightFraction } = computeBucketedHeights(bx, by, bz, 180);
  const labels = new Uint8Array(bx.length);
  for (let i = 0; i < bx.length; i++) {
    const neighbours = profile.grid.kNearestSourceIndices(angleFraction[i], heightFraction[i], k);
    let toothVotes = 0;
    for (const n of neighbours) if (profile.labels[n] === 1) toothVotes++;
    labels[i] = toothVotes * 2 >= neighbours.length ? 1 : 0;
  }
  return labels;
}
