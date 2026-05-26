import { defineConfig } from "vite-plus";

export default defineConfig({
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
