// Orchestrates the full client-side MeshSegNet pipeline — decimate ->
// build features/adjacency -> ONNX inference -> binary graph-cut -> KNN
// upsample to full resolution — entirely in the browser via
// onnxruntime-web. Validated (quality + performance) against the official
// Python/PyTorch + pygco reference pipeline before being wired in here.
//
// Model files and the WASM runtime are served locally from /public (not a
// CDN) so this keeps working without an internet connection, matching this
// app's existing "no CDN dependency" requirement (see STLViewer.tsx's
// comment on why Stage's environment map is disabled).
//
// Only ONE stage per jaw (the reference — see STLViewer.tsx) ever runs
// this full pipeline. Every other stage reuses the tooth/gum boundary it
// learns via classifyStageWithProfile() below instead of re-segmenting
// independently — see gumProfile.ts for why.

import * as THREE from "three";
import type * as OrtNamespace from "onnxruntime-web";
import { decimateToTargetCells } from "./decimate";
import { buildFeaturesAndAdjacency } from "./preprocess";
import { buildPairwiseEdges } from "./edges";
import { binaryGraphCut } from "./graphcut";
import { upsampleLabelsToFullRes } from "./upsample";
import { computeToothnessPrior } from "./geometricPrior";
import { calibrateGumProfile, classifyByGumProfile, type ReferenceProfile } from "./gumProfile";

export type Jaw = "upper" | "lower";
export type { ReferenceProfile } from "./gumProfile";

const NUM_CLASSES = 15;
// 10,000 (matching the official reference pipeline's usual scale) visibly
// under-resolved molar occlusal surfaces: the grid-based decimation (see
// decimate.ts — deliberately simple/uniform, not feature-preserving quadric
// decimation) collapses a fissure between two cusps into too few cells to
// tell it apart from a real cervical margin, which read as gingiva bleeding
// onto molar crowns. 15,000 gives ~50% more cells everywhere, including
// posterior teeth, at a proportionally higher one-time reference-stage
// inference cost — confirmed on two real, distinct patients to noticeably
// clean up molar boundaries without touching the pipeline's structure.
const TARGET_CELLS = 15000;
const MODEL_URLS: Record<Jaw, string> = {
  upper: "/models/meshsegnet_upper.onnx",
  lower: "/models/meshsegnet_lower.onnx",
};

// onnxruntime-web's threaded WASM backend spawns a Web Worker from its own
// script URL. Importing the npm package normally runs it through Turbopack,
// which rewrites that self-reference into an unservable `file://` path
// (verified: "Failed to construct 'Worker'... cannot be accessed from
// origin" at runtime). Loading the exact same file as a plain, unbundled
// module straight from /public — same as the wasm binary right next to it
// — keeps its internal worker URL resolution intact. `webpackIgnore` is
// respected by Turbopack too (see next.js turbopack docs) and skips
// bundling for this one dynamic import.
// A non-literal specifier so TypeScript treats this as an opaque dynamic
// import (Promise<any>) instead of trying to resolve "/ort/..." as a real
// module for type-checking.
const ORT_RUNTIME_URL: string = "/ort/ort.bundle.min.mjs";

let ortPromise: Promise<typeof OrtNamespace> | null = null;
function loadOrt(): Promise<typeof OrtNamespace> {
  if (!ortPromise) {
    ortPromise = import(/* webpackIgnore: true */ ORT_RUNTIME_URL).then(
      (mod: typeof OrtNamespace) => {
        mod.env.wasm.wasmPaths = "/ort/";
        if (typeof navigator !== "undefined") {
          mod.env.wasm.numThreads = navigator.hardwareConcurrency || 4;
        }
        return mod;
      }
    );
  }
  return ortPromise;
}

const sessionCache = new Map<Jaw, Promise<OrtNamespace.InferenceSession>>();

async function getSession(jaw: Jaw): Promise<OrtNamespace.InferenceSession> {
  let session = sessionCache.get(jaw);
  if (!session) {
    session = loadOrt().then((ort) =>
      ort.InferenceSession.create(MODEL_URLS[jaw], {
        executionProviders: ["wasm"],
        graphOptimizationLevel: "all",
      })
    );
    sessionCache.set(jaw, session);
  }
  return session;
}

export interface SegmentProgress {
  stage: "decimating" | "preprocessing" | "inferring" | "refining" | "upsampling" | "done";
}

export interface ReferenceSegmentResult {
  /** Full-resolution tooth(1)/gingiva(0) labels for the reference stage. */
  labels: Uint8Array;
  /** Boundary learned from this stage, reusable on every other stage. */
  profile: ReferenceProfile;
}

// Decimation, feature/adjacency building, graph-cut and upsampling below
// are plain synchronous JS on the main thread (only the ONNX `session.run`
// call actually benefits from being async/threaded). Only one segmentation
// (the reference stage, per jaw) ever runs, but upper and lower still run
// this concurrently by default — a FIFO queue serializes them so they
// don't thrash the main thread competing for CPU at the same time.
let queue: Promise<void> = Promise.resolve();

function runQueued<T>(task: () => Promise<T>): Promise<T> {
  const result = queue.then(task, task);
  queue = result.then(
    () => undefined,
    () => undefined
  );
  return result;
}

/**
 * Runs the full MeshSegNet pipeline on the reference stage's jaw mesh and
 * learns a reusable tooth/gum boundary profile from its result (see
 * gumProfile.ts). Every other stage should use classifyStageWithProfile()
 * instead of calling this again.
 */
export function segmentReferenceStage(
  fullGeometry: THREE.BufferGeometry,
  jaw: Jaw,
  onProgress?: (p: SegmentProgress) => void
): Promise<ReferenceSegmentResult> {
  return runQueued(() => segmentReferenceStageImpl(fullGeometry, jaw, onProgress));
}

async function segmentReferenceStageImpl(
  fullGeometry: THREE.BufferGeometry,
  jaw: Jaw,
  onProgress?: (p: SegmentProgress) => void
): Promise<ReferenceSegmentResult> {
  onProgress?.({ stage: "decimating" });
  const decGeometry = decimateToTargetCells(fullGeometry, TARGET_CELLS);

  onProgress?.({ stage: "preprocessing" });
  const { X, A_S, A_L, nCells, normalX, normalY, normalZ, bx, by, bz } =
    buildFeaturesAndAdjacency(decGeometry);

  onProgress?.({ stage: "inferring" });
  const ort = await loadOrt();
  const session = await getSession(jaw);
  // X is [nCells,15] row-major; the model expects [1,15,nCells] (channels-first).
  const Xcf = new Float32Array(15 * nCells);
  for (let t = 0; t < nCells; t++) {
    for (let ch = 0; ch < 15; ch++) Xcf[ch * nCells + t] = X[t * 15 + ch];
  }
  const xTensor = new ort.Tensor("float32", Xcf, [1, 15, nCells]);
  const asTensor = new ort.Tensor("float32", A_S, [1, nCells, nCells]);
  const alTensor = new ort.Tensor("float32", A_L, [1, nCells, nCells]);
  const results = await session.run({ x: xTensor, a_s: asTensor, a_l: alTensor });
  const probs = results.probs.data as Float32Array; // [1, nCells, 15] flattened

  onProgress?.({ stage: "refining" });
  const roundFactor = 100;
  const unary0 = new Float64Array(nCells); // gingiva
  const unary1 = new Float64Array(nCells); // any tooth
  for (let i = 0; i < nCells; i++) {
    let pGum = probs[i * NUM_CLASSES + 0];
    let pTooth = 0;
    for (let k = 1; k < NUM_CLASSES; k++) pTooth += probs[i * NUM_CLASSES + k];
    pGum = Math.max(pGum, 1e-6);
    pTooth = Math.max(pTooth, 1e-6);
    unary0[i] = -roundFactor * Math.log10(pGum);
    unary1[i] = -roundFactor * Math.log10(pTooth);
  }
  // Nudge ambiguous cells (weak ML confidence, unary0 ~= unary1) toward the
  // geometrically expected label — mainly corrects gingiva bleeding onto
  // the labial/incisal side of anterior teeth, where the network's own
  // signal is weakest. A confident prediction's cost gap is much larger
  // than PRIOR_WEIGHT, so it's untouched by this; only near-tossup cells
  // move. This matters even more now that this one run calibrates every
  // other stage's boundary too.
  const PRIOR_WEIGHT = 80;
  const toothness = computeToothnessPrior(bx, by, bz, normalZ);
  for (let i = 0; i < nCells; i++) {
    unary0[i] += toothness[i] * PRIOR_WEIGHT;
    unary1[i] += (1 - toothness[i]) * PRIOR_WEIGHT;
  }
  const edges = buildPairwiseEdges(
    nCells, normalX, normalY, normalZ, bx, by, bz,
    decGeometry.attributes.position, 30, roundFactor
  );
  const refinedLabels = binaryGraphCut(nCells, unary0, unary1, edges);
  const profile = calibrateGumProfile(bx, by, bz, refinedLabels);

  onProgress?.({ stage: "upsampling" });
  const { bx: fbx, by: fby, bz: fbz } = fullResCellBarycenters(fullGeometry);
  const labels = upsampleLabelsToFullRes(bx, by, bz, refinedLabels, fbx, fby, fbz, 3);

  onProgress?.({ stage: "done" });
  return { labels, profile };
}

/**
 * Classifies every other stage's mesh by re-applying the profile learned
 * from the reference stage — no ONNX inference, no graph-cut, so it's
 * cheap enough to run on every stage at import time while still tracking
 * the reference's real (not just averaged) boundary shape.
 *
 * The K-NN vote runs against the *decimated* mesh (same ~10,000-cell scale
 * as the reference profile itself), then propagates to full resolution via
 * the same majority-vote upsampling the reference stage's own pipeline
 * uses. Voting per full-resolution cell directly (~150k+ independent
 * queries) looked speckled — each cell's own nearest neighbours can flip
 * independently of its physical neighbours with no spatial smoothing,
 * unlike the graph-cut's pairwise terms. Classifying only the decimated
 * cells and upsampling gives each small patch of full-resolution triangles
 * the same label as their shared decimated cell, which is what actually
 * reads as a clean, solid boundary instead of noise.
 */
export function classifyStageWithProfile(
  fullGeometry: THREE.BufferGeometry,
  profile: ReferenceProfile
): Uint8Array {
  const decGeometry = decimateToTargetCells(fullGeometry, TARGET_CELLS);
  const decPos = decGeometry.attributes.position;
  const nDec = decPos.count / 3;
  const dbx = new Float64Array(nDec);
  const dby = new Float64Array(nDec);
  const dbz = new Float64Array(nDec);
  for (let t = 0; t < nDec; t++) {
    const i0 = t * 3, i1 = i0 + 1, i2 = i0 + 2;
    dbx[t] = (decPos.getX(i0) + decPos.getX(i1) + decPos.getX(i2)) / 3;
    dby[t] = (decPos.getY(i0) + decPos.getY(i1) + decPos.getY(i2)) / 3;
    dbz[t] = (decPos.getZ(i0) + decPos.getZ(i1) + decPos.getZ(i2)) / 3;
  }
  const decLabels = classifyByGumProfile(dbx, dby, dbz, profile);

  const { bx: fbx, by: fby, bz: fbz } = fullResCellBarycenters(fullGeometry);
  return upsampleLabelsToFullRes(dbx, dby, dbz, decLabels, fbx, fby, fbz, 3);
}

function fullResCellBarycenters(fullGeometry: THREE.BufferGeometry) {
  const fullPos = fullGeometry.attributes.position;
  const nFull = fullPos.count / 3;
  const bx = new Float64Array(nFull);
  const by = new Float64Array(nFull);
  const bz = new Float64Array(nFull);
  for (let t = 0; t < nFull; t++) {
    const i0 = t * 3, i1 = i0 + 1, i2 = i0 + 2;
    bx[t] = (fullPos.getX(i0) + fullPos.getX(i1) + fullPos.getX(i2)) / 3;
    by[t] = (fullPos.getY(i0) + fullPos.getY(i1) + fullPos.getY(i2)) / 3;
    bz[t] = (fullPos.getZ(i0) + fullPos.getZ(i1) + fullPos.getZ(i2)) / 3;
  }
  return { bx, by, bz };
}
