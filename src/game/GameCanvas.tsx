'use client';

import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { useEffect, useRef, useState } from 'react';
import type * as THREE from 'three';
import { loadModels, type ModelLibrary } from './assets';
import { Engine } from './engine';
import { CANVAS_FONT } from './hud/manual';
import { loadCanvasFont, loadFont, type Font } from './hud/text';

interface Status {
  progress: number;
  ready: boolean;
  error?: string;
}

interface Assets {
  car: ModelLibrary;
  props: ModelLibrary;
  font: Font;
}

// Loaded once per page, so React StrictMode's double mount doesn't fetch twice.
let assets: Promise<Assets> | null = null;
const progress = { car: 0, props: 0 };
function loadAll(onProgress: (p: number) => void) {
  const report = () => onProgress((progress.car + progress.props) / 2);
  assets ??= Promise.all([
    loadModels('/models/car.glb', (p) => ((progress.car = p), report())),
    loadModels('/models/props.glb', (p) => ((progress.props = p), report())),
    loadFont('/fonts/hud.typeface.json'),
    // The same face for the manual's pages, which are drawn on canvases.
    loadCanvasFont('/fonts/hud.ttf', CANVAS_FONT),
  ]).then(([car, props, font]) => ({ car, props, font }));
  return assets;
}

/** Owns the Engine and drives it from R3F's render loop. Renders nothing itself. */
function Runner({ onStatus }: { onStatus: (s: Status) => void }) {
  const scene = useThree((s) => s.scene);
  const camera = useThree((s) => s.camera) as THREE.PerspectiveCamera;
  const gl = useThree((s) => s.gl);
  const engine = useRef<Engine | null>(null);

  useEffect(() => {
    let cancelled = false;
    let created: Engine | null = null;
    const debug = new URLSearchParams(location.search).has('debug');
    loadAll((p) => onStatus({ progress: p, ready: false }))
      .then(async ({ car, props, font }) => {
        if (cancelled) return;
        created = new Engine(scene, camera, gl, car, props, font, debug);
        // Compile every shader (game + HUD) before the first frame so the start doesn't hitch.
        await Promise.all([gl.compileAsync(scene, camera), gl.compileAsync(created.hud.scene, created.hud.camera)]);
        if (cancelled) return;
        engine.current = created;
        // ?debug exposes the engine as window.hh for poking at from the console.
        if (debug) (window as unknown as { hh: Engine }).hh = created;
        onStatus({ progress: 1, ready: true });
      })
      .catch((e: unknown) => onStatus({ progress: 0, ready: false, error: String(e) }));
    return () => {
      cancelled = true;
      engine.current = null;
      created?.dispose();
    };
  }, [scene, camera, gl, onStatus]);

  // Priority 1 takes over rendering from R3F: the engine draws the game, then the HUD.
  useFrame((_, dt) => {
    const e = engine.current;
    if (!e) return;
    e.update(dt);
    e.render();
  }, 1);
  return null;
}

export default function GameCanvas() {
  const [status, setStatus] = useState<Status>({ progress: 0, ready: false });

  return (
    <div className="hh-root">
      <Canvas
        shadows="percentage"
        dpr={[1, 1.75]}
        gl={{ antialias: true, powerPreference: 'high-performance', stencil: false }}
        camera={{ fov: 62, near: 0.3, far: 3000, position: [0, 4, 10] }}
      >
        <Runner onStatus={setStatus} />
      </Canvas>
      {!status.ready && (
        <div className="hh-loading">
          <div className="hh-title">HATCHBACK HELL</div>
          {status.error ? (
            <div className="hh-error">Couldn&apos;t load the game: {status.error}</div>
          ) : (
            <>
              <div className="hh-progress">
                <div style={{ transform: `scaleX(${status.progress})` }} />
              </div>
              <div className="hh-sub">loading models…</div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
