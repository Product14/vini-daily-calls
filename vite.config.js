import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The digest template lives in `src/email/digestTemplate.cjs` as CommonJS so the
// Node crons can `require()` it synchronously (single source of truth). Vite does
// NOT convert source .cjs to ESM, so a browser `import { renderDigestHtml }` from
// it fails ("does not provide an export named …") and blanks the whole SPA. This
// plugin wraps that one self-contained CJS file (no internal require/process) in
// an ESM shim so the browser can import its named exports.
function digestCjsAsEsm() {
  return {
    name: "digest-cjs-as-esm",
    enforce: "pre",
    transform(code, id) {
      if (!id.replace(/\\/g, "/").includes("/src/email/digestTemplate.cjs")) return;
      return {
        code:
          "const module = { exports: {} };\nconst exports = module.exports;\n" +
          code +
          "\nexport default module.exports;\n" +
          "export { renderDigestHtml, buildCommentary, pickUpsell };\n",
        map: null,
      };
    },
  };
}

export default defineConfig({
  plugins: [digestCjsAsEsm(), react()],
  server: {
    proxy: {
      "/metabase-api": {
        target: "https://metabase.spyne.ai",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/metabase-api/, ""),
      },
      "/api": {
        target: "http://localhost:3002",
        changeOrigin: true,
      },
    },
  },
});
