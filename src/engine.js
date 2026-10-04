// Physics engine loading.
//
// - In the browser, `vendor/matter.min.js` is loaded as a classic script before
//   any module runs, registering `window.Matter`.
// - In Node (headless level validation / solving), the npm package is used.
//
// Keeping this in one place means the *exact same* simulation code runs in the
// game and in the level solver.

const Matter = globalThis.Matter ?? (await import('matter-js')).default;

if (!Matter) throw new Error('Matter.js failed to load');

export default Matter;
