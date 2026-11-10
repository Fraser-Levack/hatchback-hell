import * as THREE from 'three';

/** Materials shared by every HUD object. */
export function createHudMaterials() {
  const std = (color: string, o: Partial<THREE.MeshStandardMaterialParameters> = {}) =>
    new THREE.MeshStandardMaterial({ color, roughness: 0.5, metalness: 0, ...o });
  return {
    chrome: std('#dfe3e8', { metalness: 1, roughness: 0.16 }),
    gunmetal: std('#2b2f35', { metalness: 0.8, roughness: 0.35 }),
    dialFace: std('#101318', { roughness: 0.55 }),
    ivory: std('#f3efe4', { roughness: 0.45 }),
    ink: std('#15171a', { roughness: 0.6 }),
    white: std('#f4f4f2', { roughness: 0.4, emissive: '#ffffff', emissiveIntensity: 0.18 }),
    red: std('#ff2a1a', { roughness: 0.35, emissive: '#ff2a1a', emissiveIntensity: 0.7 }),
    yellow: std('#ffcf33', { roughness: 0.35, emissive: '#ffb000', emissiveIntensity: 0.55 }),
    green: std('#54e38a', { roughness: 0.35, emissive: '#22c55e', emissiveIntensity: 0.5 }),
    rubber: std('#1b1c1f', { roughness: 0.9 }),
    wood: std('#6b4423', { roughness: 0.75 }),
    lcd: std('#a9b79f', { roughness: 0.7 }),
    /** LEDs: unlit, instance-coloured, not tone mapped so they really glow. */
    led: new THREE.MeshBasicMaterial({ color: '#ffffff', toneMapped: false }),
    /** LCD segments: lit, instance-coloured. */
    lcdSeg: std('#ffffff', { roughness: 0.6 }),
    glass: new THREE.MeshStandardMaterial({
      color: '#ffffff', transparent: true, opacity: 0.1, roughness: 0.04, metalness: 0,
      envMapIntensity: 2.2, depthWrite: false,
    }),
    black: new THREE.MeshBasicMaterial({ color: '#000000' }),
  };
}

export type HudMaterials = ReturnType<typeof createHudMaterials>;
