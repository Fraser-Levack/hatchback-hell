export const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/** Frame-rate independent smoothing factor for `x += (target - x) * damp(rate, dt)`. */
export const damp = (rate: number, dt: number) => 1 - Math.exp(-rate * dt);

export const wrapAngle = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

/** Small seeded PRNG so the track layout is the same on every load. */
export function mulberry32(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Yaw convention used everywhere: a model faces +X, and rotation.y = yaw turns
 * it so that its forward axis is (cos yaw, 0, -sin yaw). Positive yaw = left.
 */
export const yawFromDir = (dx: number, dz: number) => Math.atan2(-dz, dx);
