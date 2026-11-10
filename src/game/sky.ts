import * as THREE from 'three';

export const SKY_TOP = new THREE.Color('#3f7fd0');
export const SKY_HORIZON = new THREE.Color('#c9dced');
/** Direction *towards* the sun. */
export const SUN_DIR = new THREE.Vector3(0.55, 0.52, 0.42).normalize();

/**
 * Procedural sky dome: gradient, sun disc + glare, and drifting fbm clouds.
 * Drawn at the far plane (xyww), so it never clips and costs one fullscreen pass.
 */
export function makeSky(withClouds = true) {
  const material = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
    uniforms: {
      top: { value: SKY_TOP },
      horizon: { value: SKY_HORIZON },
      sun: { value: SUN_DIR },
      time: { value: 0 },
      clouds: { value: withClouds ? 1 : 0 },
    },
    vertexShader: /* glsl */ `
      varying vec3 vDir;
      void main() {
        vDir = position;
        vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        gl_Position = p.xyww;
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 top; uniform vec3 horizon; uniform vec3 sun;
      uniform float time; uniform float clouds;
      varying vec3 vDir;

      float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
      float noise(vec2 p) {
        vec2 i = floor(p), f = fract(p);
        vec2 u = f * f * (3.0 - 2.0 * f);
        return mix(mix(hash(i), hash(i + vec2(1, 0)), u.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), u.x), u.y);
      }
      float fbm(vec2 p) {
        float v = 0.0, a = 0.5;
        for (int i = 0; i < 5; i++) { v += a * noise(p); p = p * 2.03 + vec2(1.7, 9.2); a *= 0.5; }
        return v;
      }

      void main() {
        vec3 d = normalize(vDir);
        float h = d.y;
        float sd = max(dot(d, sun), 0.0);
        vec3 c = mix(horizon, top, pow(max(h, 0.0), 0.5));
        // Warm haze towards the sun, low in the sky.
        c += vec3(1.0, 0.72, 0.42) * pow(sd, 5.0) * 0.32 * (1.0 - max(h, 0.0));

        if (h > 0.0 && clouds > 0.5) {
          vec2 uv = d.xz / (h + 0.08) * 0.9 + vec2(time * 0.006, time * 0.0025);
          float n = fbm(uv);
          float cover = smoothstep(0.5, 0.78, n) * smoothstep(0.0, 0.18, h);
          // Fake self-shadowing: sample again a step towards the sun.
          float shade = fbm(uv + sun.xz * 0.12);
          vec3 lit = vec3(1.04, 1.0, 0.96) + vec3(1.0, 0.85, 0.65) * pow(sd, 6.0) * 0.5;
          vec3 cloud = mix(lit, vec3(0.66, 0.71, 0.79), smoothstep(0.45, 0.8, shade) * 0.8);
          c = mix(c, cloud, cover * 0.92);
        }
        if (h < 0.0) c = mix(horizon, horizon * vec3(0.78, 0.86, 0.8), min(-h * 5.0, 1.0));

        // Sun disc and glare.
        c += vec3(1.0, 0.93, 0.78) * smoothstep(0.99935, 0.9997, sd) * 8.0;
        c += vec3(1.0, 0.86, 0.62) * pow(sd, 180.0) * 0.9;
        gl_FragColor = vec4(c, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  });
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(1000, 32, 16), material);
  mesh.frustumCulled = false;
  mesh.renderOrder = -1;
  mesh.name = 'sky';
  return { mesh, material };
}

/**
 * Rings of distant mountains around (cx, cz). Unlit and unfogged; the haze is
 * baked into the vertex colours (bases fade into the horizon colour).
 */
export function makeMountains(cx: number, cz: number) {
  const group = new THREE.Group();
  group.name = 'mountains';
  const layers = [
    { radius: 1500, base: 120, peak: 330, seed: 1.3, color: '#7d93ad', snow: 0.62, haze: 0.5 },
    { radius: 1050, base: 45, peak: 150, seed: 4.1, color: '#56735f', snow: 2, haze: 0.32 },
  ];
  const horizon = SKY_HORIZON.clone();
  for (const L of layers) {
    const segs = 220;
    const pos: number[] = [];
    const col: number[] = [];
    const idx: number[] = [];
    const rock = new THREE.Color(L.color).lerp(horizon, L.haze);
    const snow = new THREE.Color('#eef3f8').lerp(horizon, L.haze * 0.6);
    const tmp = new THREE.Color();
    for (let i = 0; i <= segs; i++) {
      const a = (i / segs) * Math.PI * 2;
      // Integer frequencies so the ring joins up seamlessly.
      const n =
        0.5 + 0.28 * Math.sin(a * 3 + L.seed) + 0.14 * Math.sin(a * 7 + L.seed * 2.3) +
        0.07 * Math.sin(a * 17 + L.seed * 5.1) + 0.05 * Math.sin(a * 41 + L.seed);
      const peak = L.base + (L.peak - L.base) * Math.max(0, n) + (i % 2) * 6;
      const x = cx + Math.cos(a) * L.radius, z = cz + Math.sin(a) * L.radius;
      pos.push(x, -60, z, x, peak, z);
      col.push(horizon.r, horizon.g, horizon.b);
      const top = peak / L.peak > L.snow ? snow : rock;
      tmp.copy(top);
      col.push(tmp.r, tmp.g, tmp.b);
      if (i < segs) {
        const k = i * 2;
        idx.push(k, k + 1, k + 2, k + 1, k + 3, k + 2);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    geo.setIndex(idx);
    const mesh = new THREE.Mesh(
      geo,
      new THREE.MeshBasicMaterial({ vertexColors: true, fog: false, side: THREE.DoubleSide }),
    );
    mesh.matrixAutoUpdate = false;
    group.add(mesh);
  }
  return group;
}
