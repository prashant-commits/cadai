'use client';

import React, { useEffect, useState } from 'react';
import * as THREE from 'three';
import { Canvas } from '@react-three/fiber';
import { Box } from 'lucide-react';
import { fetchArtifactText } from '@/lib/client/server-thread';
import { parseStlToGeometry } from '@/lib/engine/geometry-utils';

function IsoMesh({ geometry }: { geometry: THREE.BufferGeometry }) {
  return (
    <mesh geometry={geometry}>
      <meshStandardMaterial
        color={0x9fb0c4}
        metalness={0.15}
        roughness={0.4}
      />
    </mesh>
  );
}

export function ProjectThumbCanvas({ artifactId }: { artifactId: string }) {
  const [geometry, setGeometry] = useState<THREE.BufferGeometry | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    return () => {
      geometry?.dispose();
    };
  }, [geometry]);

  useEffect(() => {
    let cancelled = false;

    fetchArtifactText(artifactId)
      .then((text) => {
        if (cancelled) return;
        try {
          const { geometry: parsed } = parseStlToGeometry(text);
          parsed.center();
          parsed.computeBoundingBox();
          const box = parsed.boundingBox;
          if (box) {
            const size = new THREE.Vector3();
            box.getSize(size);
            const maxDim = Math.max(size.x, size.y, size.z);
            if (maxDim > 0) {
              const s = 25 / maxDim;
              parsed.scale(s, s, s);
            }
          }
          if (!cancelled) {
            setGeometry(parsed);
          }
        } catch {
          if (!cancelled) setError(true);
        }
      })
      .catch(() => {
        if (!cancelled) setError(true);
      });

    return () => {
      cancelled = true;
    };
  }, [artifactId]);

  if (error || !geometry) {
    return (
      <div
        data-slot="thumb-placeholder"
        className="flex h-28 w-full items-center justify-center rounded-lg bg-card/40 border border-border/50 text-muted-foreground"
      >
        <Box className="size-6 text-muted-foreground/60" />
      </div>
    );
  }

  return (
    <div className="h-28 w-full overflow-hidden rounded-lg bg-card/20 border border-border/40">
      <Canvas
        frameloop="demand"
        dpr={1}
        camera={{ position: [35, 35, 35], fov: 45 }}
        gl={{ alpha: true, antialias: true }}
        style={{ width: '100%', height: '100%', background: 'transparent' }}
      >
        <ambientLight intensity={0.7} />
        <directionalLight position={[20, 40, 20]} intensity={1.2} />
        <directionalLight position={[-20, -20, -20]} intensity={0.3} />
        <IsoMesh geometry={geometry} />
      </Canvas>
    </div>
  );
}
