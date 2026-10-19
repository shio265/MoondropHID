import { defineConfig } from 'bunup';
import { copy } from 'bunup/plugins';

export default defineConfig({
  entry: 'src/index.js',
  outDir: 'dist',
  format: 'esm',
  target: 'browser',
  splitting: false,
  env: 'disable',
  // The SDK already has explicit public types; do not replace them with JS inference.
  dts: false,
  plugins: [copy('src/index.d.ts').to('index.d.ts')],
  banner: '// Moondrop HID by shio265.'
});
