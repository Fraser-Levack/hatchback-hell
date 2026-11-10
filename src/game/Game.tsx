'use client';

import dynamic from 'next/dynamic';

// three.js and WebGL only exist in the browser, so skip server rendering for the
// game and keep it out of the initial page bundle.
const GameCanvas = dynamic(() => import('./GameCanvas'), {
  ssr: false,
  loading: () => (
    <div className="hh-loading">
      <div className="hh-title">HATCHBACK HELL</div>
    </div>
  ),
});

export default function Game() {
  return <GameCanvas />;
}
