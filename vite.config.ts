import { defineConfig } from "vite-plus";

export default defineConfig({
  staged: {
    "*": "vp check --fix",
  },
  fmt: {},
  lint: {
    options: { typeAware: true, typeCheck: true },
  },
  pack: {
    entry: ["src/index.ts"],
    dts: true,
    fixedExtension: false,
  },
});
