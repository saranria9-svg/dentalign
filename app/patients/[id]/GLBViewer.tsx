"use client";

import { Canvas } from "@react-three/fiber";
import { OrbitControls, useGLTF } from "@react-three/drei";

function TeethModel() {
  const { scene } = useGLTF("/models/teeth.glb");

  return <primitive object={scene} />;
}

export default function GLBViewer() {
  return (
    <div
      style={{
        width: "100%",
        height: "600px",
      }}
    >
      <Canvas camera={{ position: [0, 0, 80] }}>
        <ambientLight intensity={3} />
        <directionalLight position={[10, 10, 10]} intensity={3} />

        <TeethModel />

        <OrbitControls autoRotate autoRotateSpeed={1} />
      </Canvas>
    </div>
  );
}
