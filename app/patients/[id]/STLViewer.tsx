"use client";

import { useEffect, useRef, useState } from "react";
import { Canvas } from "@react-three/fiber";
import { OrbitControls, Stage } from "@react-three/drei";
import { STLLoader } from "three/examples/jsm/loaders/STLLoader.js";
import * as THREE from "three";
import type { OrbitControls as OrbitControlsImpl } from "three-stdlib";
import { applyProceduralDentalColors } from "./dentalColoring";
import { segmentReferenceStage, classifyStageWithProfile, type Jaw } from "./meshsegnet/segment";

export type ArchVisibility = "both" | "upper" | "lower";

// One treatment stage's raw STL buffers (a 3Shape "SubsetupN" folder, the
// initial scan, or — for imports with no staging at all — the single
// scan wrapped as a one-element list by the caller).
export interface ScanStageInput {
  label: string;
  upperBuffer: ArrayBuffer | null;
  lowerBuffer: ArrayBuffer | null;
}

interface Viewer3DProps {
  stages: ScanStageInput[];
}

type MlStatus = "idle" | "running" | "done" | "unavailable";

interface GeometryState {
  geometry: THREE.BufferGeometry | null;
  error: string | null;
  mlStatus: MlStatus;
}

function setToothGumColors(
  geometry: THREE.BufferGeometry,
  labels: Uint8Array,
  toothColor: string,
  gumColor: string
) {
  const tooth = new THREE.Color(toothColor);
  const gum = new THREE.Color(gumColor);
  const cellCount = geometry.attributes.position.count / 3;
  const colors = new Float32Array(cellCount * 3 * 3);
  for (let t = 0; t < cellCount; t++) {
    const c = labels[t] === 0 ? gum : tooth;
    for (let v = 0; v < 3; v++) {
      const idx = (t * 3 + v) * 3;
      colors[idx] = c.r; colors[idx + 1] = c.g; colors[idx + 2] = c.b;
    }
  }
  geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
}

interface AllStagesGeometry {
  states: Map<number, GeometryState>;
  processedCount: number;
  totalCount: number;
}

// Parses and colors *every* stage's jaw mesh once, eagerly, as soon as
// `stages` is available — not lazily on first visit — so Précédent/Suivant
// navigation is just reading an already-populated cache, never triggering
// any parsing or computation itself.
//
// Only one stage (the first one with a usable mesh — the "reference")
// actually runs the full MeshSegNet pipeline. Real ClearAligner treatment
// only moves teeth; the gum tissue barely shifts stage to stage. Running
// independent ML segmentation per stage let ordinary model noise/variance
// draw the tooth/gum boundary a little differently each time, which read
// as the gum sliding around between stages even though nothing there
// actually changed. So the reference's result is turned into a reusable
// boundary profile (see meshsegnet/gumProfile.ts) and every other stage is
// classified against that exact same profile — cheap (no ONNX, no
// decimation), and because the criterion is identical everywhere, the
// boundary reads as stable while the teeth move, the way dedicated
// orthodontic software (3Shape/ClinCheck) renders a staging animation.
function useAllStagesGeometry(
  stages: ScanStageInput[],
  jaw: Jaw,
  toothColor: string,
  gumColor: string
): AllStagesGeometry {
  const cacheRef = useRef<Map<number, GeometryState>>(new Map());
  const processedRef = useRef(0);
  const [, setTick] = useState(0);

  useEffect(() => {
    if (stages.length === 0) return;
    let cancelled = false;
    // A fresh cache per effect run (not a "have we already done this"
    // guard): React 19's Strict Mode runs this effect, its cleanup, then
    // the effect again on mount in dev, and a boolean guard set before the
    // first `await` would make the *second* (the one that actually stays
    // mounted) invocation see "already handled" and skip forever. Starting
    // clean each time and only using `cancelled` to drop a stale run's
    // results is what actually works with that double-invoke.
    const cache = new Map<number, GeometryState>();
    cacheRef.current = cache;
    processedRef.current = 0;

    (async () => {
      // Parse every stage up front and show an instant procedural ivory/
      // gum estimate for each, so nothing sits blank while the reference
      // segmentation (and then the fast per-stage classification) runs.
      for (let i = 0; i < stages.length; i++) {
        const buffer = jaw === "upper" ? stages[i].upperBuffer : stages[i].lowerBuffer;
        if (!buffer) continue;
        try {
          const loader = new STLLoader();
          // Copy the buffer: STLLoader.parse reads it as-is and we don't
          // want downstream consumers of the original ArrayBuffer affected.
          const geometry = loader.parse(buffer.slice(0)) as THREE.BufferGeometry & {
            hasColors?: boolean;
          };
          geometry.computeVertexNormals();
          // Plain 3Shape STL exports carry no color at all. The one
          // exception is the "Magics" binary STL color extension, which
          // STLLoader already decodes into a real per-facet "color"
          // attribute (geometry.hasColors) — when present, that's real
          // scan color and takes priority over any guesswork.
          if (!geometry.hasColors) {
            applyProceduralDentalColors(geometry, { toothColor, gumColor });
            cache.set(i, { geometry, error: null, mlStatus: "running" });
          } else {
            cache.set(i, { geometry, error: null, mlStatus: "unavailable" });
            processedRef.current += 1;
          }
        } catch (error) {
          console.error("Erreur de lecture du fichier STL :", error);
          cache.set(i, {
            geometry: null,
            error: "Impossible de lire ce fichier STL.",
            mlStatus: "idle",
          });
        }
      }
      if (cancelled) return;
      setTick((t) => t + 1);

      const referenceIndex = Array.from(cache.entries()).find(
        ([, entry]) => entry.geometry && entry.mlStatus === "running"
      )?.[0];
      if (referenceIndex === undefined) return; // nothing needs ML (all real-color or unreadable)
      const referenceGeometry = cache.get(referenceIndex)!.geometry!;

      try {
        const { labels, profile } = await segmentReferenceStage(referenceGeometry, jaw);
        if (cancelled) return;
        setToothGumColors(referenceGeometry, labels, toothColor, gumColor);
        referenceGeometry.attributes.color.needsUpdate = true;
        cache.set(referenceIndex, { geometry: referenceGeometry, error: null, mlStatus: "done" });
        processedRef.current += 1;
        setTick((t) => t + 1);

        for (let i = 0; i < stages.length; i++) {
          if (cancelled) return;
          if (i === referenceIndex) continue;
          const entry = cache.get(i);
          if (!entry?.geometry || entry.mlStatus !== "running") continue;
          const labelsI = classifyStageWithProfile(entry.geometry, profile);
          setToothGumColors(entry.geometry, labelsI, toothColor, gumColor);
          entry.geometry.attributes.color.needsUpdate = true;
          cache.set(i, { geometry: entry.geometry, error: null, mlStatus: "done" });
          processedRef.current += 1;
          setTick((t) => t + 1);
        }
      } catch (mlError) {
        console.error("Segmentation MeshSegNet indisponible :", mlError);
        if (cancelled) return;
        for (const [i, entry] of cache.entries()) {
          if (entry.mlStatus === "running") cache.set(i, { ...entry, mlStatus: "unavailable" });
        }
        setTick((t) => t + 1);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [stages, jaw, toothColor, gumColor]);

  return { states: cacheRef.current, processedCount: processedRef.current, totalCount: stages.length };
}

// Enamel-like material: low metalness, a soft clearcoat for the moist/glossy
// tooth surface, and a touch of physically-based transmission so light
// grazes through thin edges the way real enamel does. Values are kept
// subtle (not a full subsurface-scattering shader) to stay cheap enough for
// real-time rendering of two meshes.
function JawMesh({
  geometry,
  fallbackColor,
}: {
  geometry: THREE.BufferGeometry;
  fallbackColor: string;
}) {
  // Vertex colors carry the tooth/gum split (either real scan color or the
  // procedural/AI-classified estimate computed in useAllStagesGeometry).
  // The material color is left white so it doesn't tint them; fallbackColor
  // only kicks in for the unexpected case where no color attribute made it
  // through.
  const hasVertexColors = geometry.hasAttribute("color");
  return (
    <mesh geometry={geometry} rotation={[-Math.PI / 2, 0, 0]} castShadow receiveShadow>
      <meshPhysicalMaterial
        color={hasVertexColors ? "#ffffff" : fallbackColor}
        vertexColors={hasVertexColors}
        roughness={0.22}
        metalness={0}
        clearcoat={0.6}
        clearcoatRoughness={0.15}
        transmission={0.18}
        thickness={1.5}
        ior={1.5}
        attenuationColor="#e8c99b"
        attenuationDistance={1.4}
        envMapIntensity={0.9}
      />
    </mesh>
  );
}

const VISIBILITY_OPTIONS: { value: ArchVisibility; label: string }[] = [
  { value: "both", label: "Les deux arcades" },
  { value: "upper", label: "Maxillaire" },
  { value: "lower", label: "Mandibulaire" },
];

const UPPER_TOOTH_COLOR = "#f4ecd9";
const LOWER_TOOTH_COLOR = "#f1e6cf";
const UPPER_GUM_COLOR = "#e3a39a";
const LOWER_GUM_COLOR = "#e0958b";

const STAGE_HOLD_MS = 1200;

export default function STLViewer({ stages }: Viewer3DProps) {
  const [stageIndex, setStageIndex] = useState(0);
  const [autoPlaying, setAutoPlaying] = useState(false);

  // Clamp when a new scan with fewer stages gets imported.
  useEffect(() => {
    setStageIndex((i) => Math.min(i, Math.max(0, stages.length - 1)));
  }, [stages.length]);

  const currentStage = stages[stageIndex] as ScanStageInput | undefined;
  const upperAll = useAllStagesGeometry(stages, "upper", UPPER_TOOTH_COLOR, UPPER_GUM_COLOR);
  const lowerAll = useAllStagesGeometry(stages, "lower", LOWER_TOOTH_COLOR, LOWER_GUM_COLOR);
  const idleGeometry: GeometryState = { geometry: null, error: null, mlStatus: "idle" };
  const upper = upperAll.states.get(stageIndex) ?? idleGeometry;
  const lower = lowerAll.states.get(stageIndex) ?? idleGeometry;
  const preparedCount = upperAll.processedCount + lowerAll.processedCount;
  const totalToPrepare = upperAll.totalCount + lowerAll.totalCount;
  const isPreparing = totalToPrepare > 0 && preparedCount < totalToPrepare;

  const [visibility, setVisibility] = useState<ArchVisibility>("both");
  const [autoRotate, setAutoRotate] = useState(false);
  const [recording, setRecording] = useState(false);
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [videoError, setVideoError] = useState<string | null>(null);
  const controlsRef = useRef<OrbitControlsImpl | null>(null);
  const canvasContainerRef = useRef<HTMLDivElement>(null);

  const hasUpper = upper.geometry !== null;
  const hasLower = lower.geometry !== null;
  const hasAny = hasUpper || hasLower;
  const hasMultipleStages = stages.length > 1;

  // <Stage>'s adjustCamera re-fits/re-centers the camera on the bounding box
  // of whatever's currently displayed. That's the right behaviour the first
  // time a model appears (or when toggling which arch is shown), but
  // clear-aligner movement between stages is only a millimeter or two on a
  // several-centimeter arch — refitting the camera on every stage switch
  // recenters/rescales the view to compensate, which visually cancels out
  // that movement instead of letting the practitioner see it. Only allow a
  // refit once per "reason to refit" (first load, or an arch visibility
  // change), not on every stageIndex change.
  const [fitToken, setFitToken] = useState(0);
  const prevVisibilityRef = useRef(visibility);
  useEffect(() => {
    if (prevVisibilityRef.current !== visibility) {
      prevVisibilityRef.current = visibility;
      setFitToken((t) => t + 1);
    }
  }, [visibility]);
  const fittedTokenRef = useRef(-1);
  const shouldAdjustCamera = hasAny && fittedTokenRef.current !== fitToken;
  if (shouldAdjustCamera) fittedTokenRef.current = fitToken;

  useEffect(() => {
    return () => {
      if (videoUrl) URL.revokeObjectURL(videoUrl);
    };
  }, [videoUrl]);

  // Auto-play: step through stages on a timer until the last one, then stop.
  useEffect(() => {
    if (!autoPlaying) return;
    const interval = setInterval(() => {
      setStageIndex((i) => {
        if (i >= stages.length - 1) {
          setAutoPlaying(false);
          return i;
        }
        return i + 1;
      });
    }, STAGE_HOLD_MS);
    return () => clearInterval(interval);
  }, [autoPlaying, stages.length]);

  function resetView() {
    controlsRef.current?.reset();
  }

  function goToPreviousStage() {
    setStageIndex((i) => Math.max(0, i - 1));
  }

  function goToNextStage() {
    setStageIndex((i) => Math.min(stages.length - 1, i + 1));
  }

  function toggleAutoPlay() {
    setAutoPlaying((wasPlaying) => {
      // Replaying from a finished sequence should restart from the beginning
      // rather than immediately stop again at the last stage.
      if (!wasPlaying && stageIndex === stages.length - 1) {
        setStageIndex(0);
      }
      return !wasPlaying;
    });
  }

  function createVideo() {
    setAutoPlaying(false);
    if (hasMultipleStages) {
      createStagesVideo();
    } else {
      createSingleStageVideo();
    }
  }

  // Original behaviour, unchanged: 8s of camera rotation on the one model.
  function createSingleStageVideo() {
    const canvas = canvasContainerRef.current?.querySelector("canvas");
    if (!canvas) {
      setVideoError("Le rendu 3D n'est pas encore prêt.");
      return;
    }

    setVideoError(null);
    const stream = canvas.captureStream(30);
    const recorder = new MediaRecorder(stream, { mimeType: "video/webm" });
    const chunks: Blob[] = [];

    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) chunks.push(event.data);
    };

    recorder.onstop = () => {
      const blob = new Blob(chunks, { type: "video/webm" });
      // The cleanup in the effect above revokes the previous object URL
      // whenever `videoUrl` changes (and on unmount), so we only need to
      // create the new one here.
      setVideoUrl(URL.createObjectURL(blob));
      setRecording(false);
    };

    setRecording(true);
    setAutoRotate(true);
    recorder.start();

    setTimeout(() => recorder.stop(), 8000);
  }

  // Records the whole treatment evolution: restarts from stage 1, keeps the
  // camera rotating continuously, and advances one stage every
  // STAGE_HOLD_MS until the last one, using whichever geometry (AI-refined
  // or still-procedural) is already cached for each stage at the moment it
  // appears on screen — never blocking on segmentation.
  function createStagesVideo() {
    const canvas = canvasContainerRef.current?.querySelector("canvas");
    if (!canvas) {
      setVideoError("Le rendu 3D n'est pas encore prêt.");
      return;
    }

    setVideoError(null);
    const stream = canvas.captureStream(30);
    const recorder = new MediaRecorder(stream, { mimeType: "video/webm" });
    const chunks: Blob[] = [];

    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) chunks.push(event.data);
    };

    recorder.onstop = () => {
      const blob = new Blob(chunks, { type: "video/webm" });
      setVideoUrl(URL.createObjectURL(blob));
      setRecording(false);
    };

    setRecording(true);
    setAutoRotate(true);
    setStageIndex(0);
    recorder.start();

    let index = 0;
    const advance = () => {
      index += 1;
      if (index >= stages.length) {
        recorder.stop();
        return;
      }
      setStageIndex(index);
      setTimeout(advance, STAGE_HOLD_MS);
    };
    setTimeout(advance, STAGE_HOLD_MS);
  }

  return (
    <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 bg-white px-4 py-3">
        <div className="flex flex-wrap gap-1 rounded-full bg-slate-100 p-1 text-sm">
          {VISIBILITY_OPTIONS.map((option) => {
            const disabled =
              (option.value === "upper" && !hasUpper) ||
              (option.value === "lower" && !hasLower) ||
              (option.value === "both" && !hasAny);
            return (
              <button
                key={option.value}
                type="button"
                disabled={disabled}
                onClick={() => setVisibility(option.value)}
                className={`rounded-full px-3 py-1.5 font-medium transition disabled:cursor-not-allowed disabled:opacity-40 ${
                  visibility === option.value
                    ? "bg-white text-blue-600 shadow-sm"
                    : "text-slate-500 hover:text-slate-700"
                }`}
              >
                {option.label}
              </button>
            );
          })}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {isPreparing && (
            <span className="flex items-center gap-1.5 rounded-full bg-blue-50 px-3 py-1.5 text-xs font-medium text-blue-600">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-blue-500" />
              {hasMultipleStages
                ? `Préparation des étapes (${preparedCount}/${totalToPrepare})…`
                : "Segmentation IA des dents/gencives…"}
            </span>
          )}
          <button
            type="button"
            onClick={() => setAutoRotate((v) => !v)}
            className={`rounded-full px-3 py-1.5 text-sm font-medium transition ${
              autoRotate
                ? "bg-blue-600 text-white"
                : "bg-slate-100 text-slate-600 hover:bg-slate-200"
            }`}
          >
            Rotation auto
          </button>
          <button
            type="button"
            onClick={resetView}
            disabled={!hasAny}
            className="rounded-full bg-slate-100 px-3 py-1.5 text-sm font-medium text-slate-600 transition hover:bg-slate-200 disabled:cursor-not-allowed disabled:opacity-40"
          >
            Réinitialiser la vue
          </button>
          <button
            type="button"
            onClick={createVideo}
            disabled={!hasAny || recording}
            className="rounded-full bg-slate-900 px-3 py-1.5 text-sm font-medium text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:bg-slate-300"
          >
            {recording ? "🎥 Enregistrement…" : "🎥 Créer une vidéo"}
          </button>
        </div>
      </div>

      {hasMultipleStages && (
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 bg-slate-50/60 px-4 py-3">
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={goToPreviousStage}
              disabled={stageIndex === 0 || autoPlaying || recording}
              className="rounded-full bg-white px-3 py-1.5 text-sm font-medium text-slate-600 shadow-sm ring-1 ring-slate-200 transition hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-40"
            >
              ← Précédent
            </button>
            <span className="rounded-full bg-white px-3 py-1.5 text-sm font-medium text-slate-700 shadow-sm ring-1 ring-slate-200">
              {currentStage?.label ?? "—"} · {stageIndex + 1}/{stages.length}
            </span>
            <button
              type="button"
              onClick={goToNextStage}
              disabled={stageIndex === stages.length - 1 || autoPlaying || recording}
              className="rounded-full bg-white px-3 py-1.5 text-sm font-medium text-slate-600 shadow-sm ring-1 ring-slate-200 transition hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-40"
            >
              Suivant →
            </button>
          </div>
          <button
            type="button"
            onClick={toggleAutoPlay}
            disabled={recording}
            className={`rounded-full px-3 py-1.5 text-sm font-medium transition disabled:cursor-not-allowed disabled:opacity-40 ${
              autoPlaying
                ? "bg-blue-600 text-white"
                : "bg-white text-slate-600 shadow-sm ring-1 ring-slate-200 hover:bg-slate-100"
            }`}
          >
            {autoPlaying ? "⏸ Pause" : "▶ Lecture automatique"}
          </button>
        </div>
      )}

      <div ref={canvasContainerRef} className="h-[520px] w-full bg-slate-50">
        {hasAny ? (
          <Canvas shadows camera={{ position: [0, 40, 110], fov: 45 }}>
            <color attach="background" args={["#f1f5f9"]} />
            {/*
              A hemisphere light stands in for ambient fill instead of a flat
              ambientLight: cool tone from above, warm bounce from below,
              which reads much closer to real operatory lighting on enamel.
            */}
            <hemisphereLight args={["#dce8ff", "#8a7d6e", 0.55]} />
            <directionalLight
              position={[40, 60, 40]}
              intensity={1.6}
              castShadow
              shadow-mapSize={[2048, 2048]}
              shadow-bias={-0.0004}
            >
              {/*
                The default directional-light shadow frustum (±5 units) is
                far too tight for a full dental arch and silently clips the
                shadow; widen it to cover the model.
              */}
              <orthographicCamera attach="shadow-camera" args={[-80, 80, 80, -80, 1, 300]} />
            </directionalLight>
            <directionalLight position={[-40, 20, -30]} intensity={0.45} color="#fff1e0" />
            {/*
              `environment={null}` disables Stage's default HDRI reflection
              map (which otherwise fetches a remote asset from a CDN). A
              chairside app needs to render reliably without depending on
              internet access, so we rely on the lights above instead.
            */}
            <Stage
              environment={null}
              intensity={0.5}
              shadows={{ type: "contact", opacity: 0.5, blur: 2.5, size: 2048 }}
              adjustCamera={shouldAdjustCamera ? 1.3 : false}
            >
              {(visibility === "both" || visibility === "upper") &&
                upper.geometry && (
                  <JawMesh geometry={upper.geometry} fallbackColor={UPPER_TOOTH_COLOR} />
                )}
              {(visibility === "both" || visibility === "lower") &&
                lower.geometry && (
                  <JawMesh geometry={lower.geometry} fallbackColor={LOWER_TOOTH_COLOR} />
                )}
            </Stage>
            <OrbitControls
              ref={controlsRef}
              makeDefault
              autoRotate={autoRotate}
              autoRotateSpeed={1.2}
              enablePan
              enableZoom
              enableRotate
              minDistance={20}
              maxDistance={400}
            />
          </Canvas>
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-center text-slate-400">
            <span className="text-4xl">🦷</span>
            <p className="text-sm">Aucun modèle 3D importé pour ce patient</p>
          </div>
        )}
      </div>

      {(upper.error || lower.error || videoError) && (
        <div className="border-t border-red-100 bg-red-50 px-4 py-2 text-xs text-red-600">
          {upper.error || lower.error || videoError}
        </div>
      )}

      {videoUrl && (
        <div className="border-t border-slate-200 p-4">
          <h3 className="text-sm font-semibold text-slate-900">
            Vidéo générée
          </h3>
          <video
            src={videoUrl}
            controls
            className="mt-2 w-full max-w-md rounded-xl"
          />
        </div>
      )}
    </div>
  );
}
