"use client";

import { useEffect, useRef, useState } from "react";
import { Canvas } from "@react-three/fiber";
import { OrbitControls, Stage } from "@react-three/drei";
import { STLLoader } from "three/examples/jsm/loaders/STLLoader.js";
import * as THREE from "three";
import type { OrbitControls as OrbitControlsImpl } from "three-stdlib";
import { applyProceduralDentalColors } from "./dentalColoring";
import { segmentToothGum, type Jaw } from "./meshsegnet/segment";

export type ArchVisibility = "both" | "upper" | "lower";

interface Viewer3DProps {
  upperBuffer: ArrayBuffer | null;
  lowerBuffer: ArrayBuffer | null;
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

function useStlGeometry(
  buffer: ArrayBuffer | null,
  jaw: Jaw,
  toothColor: string,
  gumColor: string
): GeometryState {
  const [state, setState] = useState<GeometryState>({
    geometry: null,
    error: null,
    mlStatus: "idle",
  });

  useEffect(() => {
    if (!buffer) {
      setState({ geometry: null, error: null, mlStatus: "idle" });
      return;
    }
    let cancelled = false;
    try {
      const loader = new STLLoader();
      // Copy the buffer: STLLoader.parse reads it as-is and we don't want
      // downstream consumers of the original ArrayBuffer to be affected.
      const geometry = loader.parse(buffer.slice(0)) as THREE.BufferGeometry & {
        hasColors?: boolean;
      };
      geometry.computeVertexNormals();
      // Plain 3Shape STL exports carry no color at all. The one exception
      // is the "Magics" binary STL color extension, which STLLoader already
      // decodes into a real per-facet "color" attribute (geometry.hasColors)
      // — when present, that's real scan color and takes priority over any
      // guesswork. Otherwise, show an immediate procedural ivory/gum
      // estimate, then refine it in the background with the MeshSegNet ONNX
      // model (real tooth/gingiva segmentation, ~10s client-side) once it's
      // ready — the procedural pass means the viewer never sits blank while
      // that runs.
      if (!geometry.hasColors) {
        applyProceduralDentalColors(geometry, { toothColor, gumColor });
        setState({ geometry, error: null, mlStatus: "running" });

        segmentToothGum(geometry, jaw)
          .then((labels) => {
            if (cancelled) return;
            setToothGumColors(geometry, labels, toothColor, gumColor);
            geometry.attributes.color.needsUpdate = true;
            setState({ geometry, error: null, mlStatus: "done" });
          })
          .catch((mlError) => {
            console.error("Segmentation MeshSegNet indisponible :", mlError);
            if (!cancelled) setState({ geometry, error: null, mlStatus: "unavailable" });
          });
      } else {
        setState({ geometry, error: null, mlStatus: "unavailable" });
      }
    } catch (error) {
      console.error("Erreur de lecture du fichier STL :", error);
      setState({
        geometry: null,
        error: "Impossible de lire ce fichier STL.",
        mlStatus: "idle",
      });
    }
    return () => {
      cancelled = true;
    };
  }, [buffer, jaw, toothColor, gumColor]);

  return state;
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
  // procedural ivory/gum estimate computed in useStlGeometry). The material
  // color is left white so it doesn't tint them; fallbackColor only kicks
  // in for the unexpected case where no color attribute made it through.
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

export default function STLViewer({ upperBuffer, lowerBuffer }: Viewer3DProps) {
  const upper = useStlGeometry(upperBuffer, "upper", UPPER_TOOTH_COLOR, UPPER_GUM_COLOR);
  const lower = useStlGeometry(lowerBuffer, "lower", LOWER_TOOTH_COLOR, LOWER_GUM_COLOR);

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
  const mlRunning = upper.mlStatus === "running" || lower.mlStatus === "running";

  useEffect(() => {
    return () => {
      if (videoUrl) URL.revokeObjectURL(videoUrl);
    };
  }, [videoUrl]);

  function resetView() {
    controlsRef.current?.reset();
  }

  function createVideo() {
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
          {mlRunning && (
            <span className="flex items-center gap-1.5 rounded-full bg-blue-50 px-3 py-1.5 text-xs font-medium text-blue-600">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-blue-500" />
              Segmentation IA des dents/gencives…
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
              adjustCamera={1.3}
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
