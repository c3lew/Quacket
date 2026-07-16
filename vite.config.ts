import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Tauri drives the dev server, so the port is fixed and src-tauri is not watched.
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    watch: { ignored: ['**/src-tauri/**'] },
  },
  test: {
    globals: true,
    /*
     * The core is headless by construction and must stay fast, so 'node' remains
     * the DEFAULT — nothing under src/core has ever needed a DOM and nothing
     * should start.
     *
     * `.tsx` is collected all the same. The rule "if it is worth testing it does
     * not go in a .tsx" is still the right instinct, but it silently became "the
     * .tsx cannot be tested, so whatever is left in it is unverifiable" — and
     * every lifecycle blocker v1 shipped lived in exactly that blind spot. What
     * a reducer decides and what the wiring actually PERFORMS are two different
     * claims; only a rendered component can prove the second.
     *
     * A file that needs a DOM opts in per-file with a `// @vitest-environment
     * jsdom` docblock, so the headless suite never pays for it.
     */
    environment: 'node',
    include: ['src/**/*.test.{ts,tsx}'],
  },
});
