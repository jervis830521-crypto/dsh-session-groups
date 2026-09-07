// Client half bundle: CJS closure-factory artifact consumed by the dsh web
// module loader (window.__ModuleLoader__.load handoff, externals resolved
// through the injected require). React and the slots runtime are shell-seeded
// platform modules (packages/client/web/src/platform.ts PLATFORM_MODULES) 鈥?// they stay imports; everything else inlines.
//
// Plain-object config on purpose: the dsh checkout's tsdown CLI evaluates this
// file, and a `tsdown` package import would not resolve from this lab plugin.
const ID = 'dsh-session-groups'

export default {
  name: `${ID}/client`,
  entry: { client: 'src/client/index.tsx' },
  outDir: 'lib',
  format: 'cjs',
  platform: 'browser',
  target: 'es2024',
  dts: false,
  sourcemap: true,
  clean: false,
  tsconfig: 'tsconfig.client.json',
  deps: {
    neverBundle: [/^react(\/|$)/, /^react-dom(\/|$)/, /^@deepseek-ai\//],
  },
  outputOptions: {
    entryFileNames: 'client.js',
    banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(ID)}, factory: (require) => {`,
    footer: 'return module.exports; } });',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
  },
}
