import { minify, type MinifyOptions, type MinifyResult } from "oxc-minify";
import { validate } from "schema-utils";
import type { AssetInfo, Compiler, Compilation, sources as webpackSources } from "webpack";

const rulesSchema = {
  anyOf: [
    { instanceof: "RegExp" },
    { type: "string" as const },
    {
      type: "array" as const,
      items: {
        anyOf: [{ instanceof: "RegExp" }, { type: "string" as const }],
      },
    },
  ],
};

const schema = {
  title: "OxcMinifyPluginOptions",
  type: "object" as const,
  additionalProperties: false,
  properties: {
    test: rulesSchema,
    include: rulesSchema,
    exclude: rulesSchema,
    minifyOptions: {
      type: "object" as const,
      additionalProperties: true,
    },
    extractComments: { type: "boolean" as const },
  },
};

type Rule = string | RegExp;
type Rules = Rule | Rule[];

export interface OxcMinifyPluginOptions {
  test?: Rules;
  include?: Rules;
  exclude?: Rules;
  minifyOptions?: MinifyOptions;
  extractComments?: boolean;
}

interface ResolvedOptions {
  test: Rules;
  include?: Rules;
  exclude?: Rules;
  minifyOptions: MinifyOptions;
  extractComments: boolean;
}

const CSS_EXTENSION_DETECT_REGEXP = /\.css(\?.*)?$/i;
const JS_EXTENSION_DETECT_REGEXP = /\.[cm]?js(\?.*)?$/i;

const PLUGIN_NAME = "OxcMinifyPlugin";

export class OxcMinifyPlugin {
  private options: ResolvedOptions;

  constructor(options: OxcMinifyPluginOptions = {}) {
    validate(schema as Parameters<typeof validate>[0], options, {
      name: PLUGIN_NAME,
      baseDataPath: "options",
    });

    this.options = {
      test: options.test ?? JS_EXTENSION_DETECT_REGEXP,
      include: options.include,
      exclude: options.exclude,
      extractComments: options.extractComments ?? true,
      minifyOptions: options.minifyOptions ?? {},
    };
  }

  apply(compiler: Compiler) {
    compiler.hooks.compilation.tap(PLUGIN_NAME, (compilation) => {
      compilation.hooks.processAssets.tapPromise(
        {
          name: PLUGIN_NAME,
          stage: compiler.webpack.Compilation.PROCESS_ASSETS_STAGE_OPTIMIZE_SIZE,
          additionalAssets: true,
        },
        async (assets) => {
          await this.optimize(compiler, compilation, assets);
        },
      );

      compilation.hooks.statsPrinter.tap(PLUGIN_NAME, (stats) => {
        stats.hooks.print
          .for("asset.info.minimized")
          .tap(PLUGIN_NAME, (minimized, { green, formatFlag }) =>
            minimized && green && formatFlag ? green(formatFlag("minimized")) : "",
          );
      });
    });
  }

  private async optimize(
    compiler: Compiler,
    compilation: Compilation,
    assets: Record<string, webpackSources.Source>,
  ) {
    const { SourceMapSource, RawSource } = compiler.webpack.sources;
    const { ModuleFilenameHelpers, WebpackError } = compiler.webpack;
    const cache = compilation.getCache(PLUGIN_NAME);
    const { devtool } = compiler.options;
    const sourcemap =
      this.options.minifyOptions.sourcemap ??
      (typeof devtool === "string" && devtool.includes("source-map"));

    const matchObject = ModuleFilenameHelpers.matchObject.bind(undefined, {
      test: this.options.test,
      include: this.options.include,
      exclude: this.options.exclude,
    });

    const ecmaTarget = getEcmaTarget(
      compiler.options.output?.environment as Record<string, boolean | undefined> | undefined,
    );

    const assetsToMinify: Array<{
      name: string;
      info: AssetInfo;
      source: webpackSources.Source;
    }> = [];

    for (const name of Object.keys(assets)) {
      if (!matchObject(name)) continue;
      if (CSS_EXTENSION_DETECT_REGEXP.test(name)) continue;

      const asset = compilation.getAsset(name);
      if (!asset) continue;
      if (asset.info.minimized) continue;

      assetsToMinify.push({ name, info: asset.info, source: asset.source });
    }

    await Promise.all(
      assetsToMinify.map(async ({ name, info, source }) => {
        const eTag = cache.getLazyHashedEtag(source);
        const cacheItem = cache.getItemCache(name, eTag);
        const cacheOutput = await cacheItem.getPromise<{
          source: webpackSources.Source;
          extractedCommentsSource?: webpackSources.Source;
        }>();

        if (cacheOutput) {
          this.applyResult(
            compilation,
            name,
            info,
            cacheOutput.source,
            cacheOutput.extractedCommentsSource,
          );
          return;
        }

        const { source: sourceCode, map: inputSourceMap } = source.sourceAndMap();
        const sourceAsString = typeof sourceCode === "string" ? sourceCode : sourceCode.toString();

        const isModule =
          this.options.minifyOptions.module ?? info.javascriptModule ?? /\.mjs(\?.*)?$/i.test(name);

        const commentsFile = `${name}.LICENSE.txt`;
        const codegenOptions =
          typeof this.options.minifyOptions.codegen === "object"
            ? { ...this.options.minifyOptions.codegen }
            : {};
        codegenOptions.legalComments = this.options.extractComments
          ? { linked: commentsFile }
          : "none";

        const minifyOptions: MinifyOptions = {
          ...this.options.minifyOptions,
          module: isModule,
          sourcemap,
          codegen: codegenOptions,
          compress:
            this.options.minifyOptions.compress !== false
              ? {
                  ...(typeof this.options.minifyOptions.compress === "object"
                    ? this.options.minifyOptions.compress
                    : {}),
                  target: ecmaTarget,
                }
              : false,
        };

        let result: MinifyResult;
        try {
          result = await minify(name, sourceAsString, minifyOptions);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          const webpackError = new WebpackError(
            `${PLUGIN_NAME}: Error minifying ${name}: ${message}`,
          );
          webpackError.name = PLUGIN_NAME;
          compilation.errors.push(webpackError);
          return;
        }

        for (const diagnostic of result.errors) {
          const formatted = new WebpackError(
            `${PLUGIN_NAME}: ${name}: ${diagnostic.message}${diagnostic.codeframe ? "\n" + diagnostic.codeframe : ""}`,
          );
          formatted.name = PLUGIN_NAME;
          if (diagnostic.severity === "Error") {
            compilation.errors.push(formatted);
          } else {
            compilation.warnings.push(formatted);
          }
        }

        let outputCode = result.code;

        // Preserve shebang
        const shebangMatch = sourceAsString.match(/^#!(.*)/);
        if (shebangMatch) {
          outputCode = `#!${shebangMatch[1]}\n${outputCode}`;
        }

        let extractedCommentsSource: webpackSources.Source | undefined;
        if (this.options.extractComments && result.legalComments.length > 0) {
          const commentsText = result.legalComments.join("\n\n");
          extractedCommentsSource = new RawSource(`${commentsText}\n`);
        }

        type SourceMapInput = NonNullable<ConstructorParameters<typeof SourceMapSource>[2]>;
        const outputMap = result.map as unknown as SourceMapInput;

        let outputSource: webpackSources.Source;
        if (result.map && inputSourceMap) {
          outputSource = new SourceMapSource(
            outputCode,
            name,
            outputMap,
            sourceAsString,
            inputSourceMap as SourceMapInput,
            true,
          );
        } else if (result.map) {
          outputSource = new SourceMapSource(outputCode, name, outputMap);
        } else {
          outputSource = new RawSource(outputCode);
        }

        await cacheItem.storePromise({
          source: outputSource,
          extractedCommentsSource,
        });

        this.applyResult(compilation, name, info, outputSource, extractedCommentsSource);
      }),
    );
  }

  private applyResult(
    compilation: Compilation,
    name: string,
    info: AssetInfo,
    source: webpackSources.Source,
    extractedCommentsSource?: webpackSources.Source,
  ) {
    compilation.updateAsset(name, source, {
      ...info,
      minimized: true,
    });

    if (extractedCommentsSource) {
      const commentsFile = `${name}.LICENSE.txt`;
      if (compilation.getAsset(commentsFile)) {
        compilation.updateAsset(commentsFile, extractedCommentsSource);
      } else {
        compilation.emitAsset(commentsFile, extractedCommentsSource, {
          extractedComments: true,
        });
      }
    }
  }
}

function getEcmaTarget(environment?: Record<string, boolean | undefined>): string {
  if (!environment) return "es5";
  if (environment.dynamicImport || environment.module) return "es2020";
  if (
    environment.arrowFunction ||
    environment.const ||
    environment.destructuring ||
    environment.forOf ||
    environment.templateLiteral
  ) {
    return "es2015";
  }
  return "es5";
}

export default OxcMinifyPlugin;
