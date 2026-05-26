import { describe, expect, it } from "vite-plus/test";
import { OxcMinifyPlugin } from "../src/index.js";
import { compile } from "./helpers.js";

describe("OxcMinifyPlugin", () => {
  it("minifies emitted JS assets and marks them minimized", async () => {
    const { assets, assetInfo } = await compile({
      entry: "./basic.js",
      output: { filename: "out.js" },
      plugins: [new OxcMinifyPlugin()],
    });

    const code = assets["out.js"];
    expect(code).toBeDefined();
    expect(assetInfo["out.js"].minimized).toBe(true);
    expect(code).not.toMatch(/longName/);
    expect(code.split("\n").length).toBeLessThan(5);
  });

  it("extracts legal comments to a .LICENSE.txt file and links to it", async () => {
    const { assets, assetInfo } = await compile({
      entry: "./with-license.js",
      output: { filename: "out.js" },
      plugins: [new OxcMinifyPlugin({ extractComments: true })],
    });

    const code = assets["out.js"];
    const license = assets["out.js.LICENSE.txt"];

    expect(license).toBeDefined();
    expect(license).toContain("@license MIT");
    expect(license).toContain("Copyright (c) 2026 Test Inc.");
    expect(code).toContain("out.js.LICENSE.txt");
    expect(code).not.toContain("Copyright (c) 2026 Test Inc.");
    expect(assetInfo["out.js.LICENSE.txt"].extractedComments).toBe(true);
  });

  it("omits the license file when extractComments is false", async () => {
    const { assets } = await compile({
      entry: "./with-license.js",
      output: { filename: "out.js" },
      plugins: [new OxcMinifyPlugin({ extractComments: false })],
    });

    expect(assets["out.js.LICENSE.txt"]).toBeUndefined();
    expect(assets["out.js"]).not.toContain("@license");
    expect(assets["out.js"]).not.toContain("LICENSE.txt");
  });

  it("skips assets matched by the exclude option", async () => {
    const { assetInfo } = await compile({
      entry: "./excluded.js",
      output: { filename: "skip.js" },
      plugins: [new OxcMinifyPlugin({ exclude: /skip\.js$/ })],
    });

    expect(assetInfo["skip.js"].minimized).toBeUndefined();
  });

  it("produces a source map when devtool is source-map", async () => {
    const { assets } = await compile({
      entry: "./basic.js",
      output: { filename: "out.js" },
      devtool: "source-map",
      plugins: [new OxcMinifyPlugin()],
    });

    expect(assets["out.js.map"]).toBeDefined();
    const map = JSON.parse(assets["out.js.map"]);
    expect(map.version).toBe(3);
    expect(map.mappings).toBeTypeOf("string");
    expect(map.mappings.length).toBeGreaterThan(0);
  });

  it("does not re-minify assets already marked as minimized", async () => {
    const { assetInfo } = await compile({
      entry: "./basic.js",
      output: { filename: "out.js" },
      plugins: [new OxcMinifyPlugin(), new OxcMinifyPlugin()],
    });

    expect(assetInfo["out.js"].minimized).toBe(true);
  });
});
