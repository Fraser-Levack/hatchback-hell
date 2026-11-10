import { clamp } from './math';

const BLOCKED = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space']);

/** Keyboard + gamepad state, polled once per frame. */
export class Input {
  throttle = 0;
  brake = 0;
  /** -1 (right) .. 1 (left) */
  steer = 0;
  handbrake = false;

  private down = new Set<string>();
  private edges = new Set<string>();
  private padButtons: boolean[] = [];

  private onKeyDown = (e: KeyboardEvent) => {
    if (BLOCKED.has(e.code)) e.preventDefault();
    if (!e.repeat) this.edges.add(e.code);
    this.down.add(e.code);
  };
  private onKeyUp = (e: KeyboardEvent) => this.down.delete(e.code);
  private onBlur = () => this.down.clear();

  constructor() {
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('blur', this.onBlur);
  }

  dispose() {
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    window.removeEventListener('blur', this.onBlur);
  }

  private key(...codes: string[]) {
    for (const c of codes) if (this.down.has(c)) return true;
    return false;
  }

  /** True once per key press. */
  pressed(code: string) {
    const hit = this.edges.has(code);
    this.edges.delete(code);
    return hit;
  }

  update(dt: number) {
    let throttle = this.key('KeyW', 'ArrowUp') ? 1 : 0;
    let brake = this.key('KeyS', 'ArrowDown') ? 1 : 0;
    const steerKeys = (this.key('KeyA', 'ArrowLeft') ? 1 : 0) - (this.key('KeyD', 'ArrowRight') ? 1 : 0);
    let handbrake = this.key('Space');

    // Keyboard steering ramps in and snaps back, so taps make small corrections.
    const rate = steerKeys === 0 || Math.sign(steerKeys) !== Math.sign(this.steer) ? 9 : 4.5;
    let steer = this.steer + clamp(steerKeys - this.steer, -rate * dt, rate * dt);

    const pad = typeof navigator !== 'undefined' && navigator.getGamepads ? navigator.getGamepads()[0] : null;
    if (pad) {
      const axis = pad.axes[0] ?? 0;
      if (Math.abs(axis) > 0.12) steer = -axis;
      throttle = Math.max(throttle, pad.buttons[7]?.value ?? 0);
      brake = Math.max(brake, pad.buttons[6]?.value ?? 0);
      handbrake ||= !!pad.buttons[0]?.pressed || !!pad.buttons[1]?.pressed;
      // Map a few pad buttons onto the keyboard edge events.
      const map: [number, string][] = [[3, 'KeyR'], [9, 'Enter'], [2, 'KeyC']];
      for (const [b, code] of map) {
        const p = !!pad.buttons[b]?.pressed;
        if (p && !this.padButtons[b]) this.edges.add(code);
        this.padButtons[b] = p;
      }
    }

    this.throttle = throttle;
    this.brake = brake;
    this.steer = clamp(steer, -1, 1);
    this.handbrake = handbrake;
  }
}
