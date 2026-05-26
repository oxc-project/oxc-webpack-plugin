import path from "node:path";
import { fileURLToPath } from "node:url";
import { createFsFromVolume, Volume } from "memfs";
import webpack, { type Configuration, type Stats } from "webpack";

const fixturesDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "fixtures");

export interface CompileResult {
  stats: Stats;
  volume: InstanceType<typeof Volume>;
  assets: Record<string, string>;
  assetInfo: Record<string, { minimized?: boolean; extractedComments?: boolean }>;
}

export async function compile(config: Configuration): Promise<CompileResult> {
  const volume = new Volume();
  const outputFileSystem = createFsFromVolume(volume);

  const compiler = webpack({
    mode: "production",
    context: fixturesDir,
    optimization: { minimize: false },
    ...config,
    output: {
      path: "/dist",
      ...config.output,
    },
  });

  compiler.outputFileSystem = outputFileSystem as unknown as typeof compiler.outputFileSystem;

  const stats = await new Promise<Stats>((resolve, reject) => {
    compiler.run((err, stats) => {
      if (err) reject(err);
      else if (!stats) reject(new Error("No stats"));
      else resolve(stats);
    });
  });

  await new Promise<void>((resolve, reject) => {
    compiler.close((err) => (err ? reject(err) : resolve()));
  });

  const assets: Record<string, string> = {};
  const assetInfo: CompileResult["assetInfo"] = {};
  for (const asset of stats.compilation.getAssets()) {
    const buf = volume.readFileSync(`/dist/${asset.name}`);
    assets[asset.name] = buf.toString();
    assetInfo[asset.name] = asset.info as CompileResult["assetInfo"][string];
  }

  return { stats, volume, assets, assetInfo };
}
