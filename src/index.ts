import { minify, type MinifyOptions, type MinifyResult } from "oxc-minify";
import { validate } from "schema-utils";
import type { Compiler, Compilation, sources as webpackSources } from "webpack";

const schema = {
  title: "OxcMinifyPluginOptions",
  type: "object" as const,
  additionalProperties: false,
  properties: {
    test: {
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
    },
    include: {
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
    },
    exclude: {
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
    },
    minifyOptions: {
      type: "object" as const,
      additionalProperties: true,
    },
    extractComments: {
      anyOf: [{ type: "boolean" as const }],
    },
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

const CSS_EXTENSION_DETECT_REGEXP = /\.css(\?.*)?$/i;
const JS_EXTENSION_DETECT_REGEXP = /\.[cm]?js(\?.*)?$/i;

const PLUGIN_NAME = "OxcMinifyPlugin";

export class OxcMinifyPlugin {
  private options: Required<
    Pick<OxcMinifyPluginOptions, "test" | "extractComments">
  > & {
    include?: Rules;
    exclude?: Rules;
    minifyOptions: MinifyOptions;
  };

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
    const { SourceMapSource, RawSource } =
      compiler.webpack.sources;
    const { ModuleFilenameHelpers } = compiler.webpack;

    compiler.hooks.compilation.tap(PLUGIN_NAME, (compilation) => {
      compilation.hooks.processAssets.tapPromise(
        {
          name: PLUGIN_NAME,
          stage:
            compiler.webpack.Compilation.PROCESS_ASSETS_STAGE_OPTIMIZE_SIZE,
          additionalAssets: true,
        },
        async (assets) => {
          await this.optimize(
            compiler,
            compilation,
            assets,
            SourceMapSource,
            RawSource,
            ModuleFilenameHelpers,
          );
        },
      );

      compilation.hooks.statsPrinter.tap(PLUGIN_NAME, (stats) => {
        stats.hooks.print
          .for("asset.info.minimized")
          .tap(PLUGIN_NAME, (minimized, { green, formatFlag }) =>
            minimized && green && formatFlag
              ? green(formatFlag("minimized"))
              : "",
          );
      });
    });
  }

  private async optimize(
    compiler: Compiler,
    compilation: Compilation,
    assets: Record<string, webpackSources.Source>,
    SourceMapSource: typeof webpackSources.SourceMapSource,
    RawSource: typeof webpackSources.RawSource,
    ModuleFilenameHelpers: typeof import("webpack").ModuleFilenameHelpers,
  ) {
    const cache = compilation.getCache(PLUGIN_NAME);
    const { devtool } = compiler.options;
    const sourcemap =
      this.options.minifyOptions.sourcemap ??
      (devtool
        ? (devtool as string).includes("source-map")
        : false);

    const matchObject = ModuleFilenameHelpers.matchObject.bind(
      undefined,
      {
        test: this.options.test,
        include: this.options.include,
        exclude: this.options.exclude,
      },
    );

    const assetsToMinify: Array<{
      name: string;
      info: ReturnType<Compilation["getAsset"]> extends
        | { info: infer I }
        | undefined
        ? I
        : never;
      source: webpackSources.Source;
    }> = [];

    for (const name of Object.keys(assets)) {
      if (!matchObject(name)) continue;
      if (CSS_EXTENSION_DETECT_REGEXP.test(name)) continue;

      const info = compilation.getAsset(name)?.info;
      if (!info) continue;
      if (info.minimized) continue;

      assetsToMinify.push({ name, info, source: compilation.getAsset(name)!.source });
    }

    const scheduledTasks: Promise<void>[] = [];

    for (const asset of assetsToMinify) {
      scheduledTasks.push(
        (async () => {
          const { name, info, source } = asset;

          const eTag = cache.getLazyHashedEtag(source);
          const cacheItem = cache.getItemCache(name, eTag);
          const cacheOutput = await cacheItem.getPromise<{
            source: webpackSources.Source;
            extractedCommentsSource?: webpackSources.Source;
          }>();

          if (cacheOutput) {
            await this.applyResult(
              compilation,
              name,
              info,
              cacheOutput.source,
              cacheOutput.extractedCommentsSource,
            );
            return;
          }

          const { source: sourceCode, map: inputSourceMap } =
            source.sourceAndMap();
          const sourceAsString =
            typeof sourceCode === "string"
              ? sourceCode
              : sourceCode.toString();

          // Detect if this is an ES module
          const isModule =
            this.options.minifyOptions.module ??
            info.javascriptModule ??
            /\.mjs(\?.*)?$/i.test(name);

          // Detect ecma target from webpack output environment
          const ecmaTarget = getEcmaTarget(compiler.options.output?.environment as Record<string, boolean | undefined> | undefined);

          const minifyOptions: MinifyOptions = {
            ...this.options.minifyOptions,
            module: isModule,
            sourcemap: sourcemap,
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
            const webpackError = new compiler.webpack.WebpackError(
              `${PLUGIN_NAME}: Error minifying ${name}: ${error}`,
            );
            webpackError.name = PLUGIN_NAME;
            compilation.errors.push(webpackError);
            return;
          }

          if (result.errors.length > 0) {
            for (const error of result.errors) {
              const warning = new compiler.webpack.WebpackError(
                `${PLUGIN_NAME}: ${name}: ${error.message}${error.codeframe ? "\n" + error.codeframe : ""}`,
              );
              warning.name = PLUGIN_NAME;
              compilation.warnings.push(warning);
            }
          }

          let outputCode = result.code;

          // Preserve shebang
          const shebangMatch = sourceAsString.match(/^#!(.*)/);
          if (shebangMatch) {
            outputCode = `#!${shebangMatch[1]}\n${outputCode}`;
          }

          // Handle extracted comments
          let extractedCommentsSource: webpackSources.Source | undefined;
          if (this.options.extractComments) {
            const { code, comments } = extractLicenseComments(outputCode);
            if (comments.length > 0) {
              outputCode = code;
              const commentsFile = `${name}.LICENSE.txt`;
              const commentsText = comments.join("\n\n");
              extractedCommentsSource = new RawSource(
                `${commentsText}\n`,
              );

              // Add banner pointing to license file
              const banner = `/*! For license information please see ${commentsFile} */`;
              outputCode = `${banner}\n${outputCode}`;
            }
          }

          let outputSource: webpackSources.Source;
          if (result.map && inputSourceMap) {
            outputSource = new SourceMapSource(
              outputCode,
              name,
              result.map as any,
              sourceAsString,
              inputSourceMap as any,
              true,
            );
          } else if (result.map) {
            outputSource = new SourceMapSource(
              outputCode,
              name,
              result.map as any,
            );
          } else {
            outputSource = new RawSource(outputCode);
          }

          await cacheItem.storePromise({
            source: outputSource,
            extractedCommentsSource,
          });

          await this.applyResult(
            compilation,
            name,
            info,
            outputSource,
            extractedCommentsSource,
          );
        })(),
      );
    }

    await Promise.all(scheduledTasks);
  }

  private async applyResult(
    compilation: Compilation,
    name: string,
    info: any,
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

function extractLicenseComments(code: string): {
  code: string;
  comments: string[];
} {
  const comments: string[] = [];
  const resultCode = code.replace(
    /\/\*[*!][\s\S]*?\*\//g,
    (match) => {
      if (isLicenseComment(match)) {
        comments.push(match);
        return "";
      }
      return match;
    },
  );
  return { code: resultCode, comments };
}

function isLicenseComment(comment: string): boolean {
  // Match comments that contain @license, @preserve, or start with /*!
  return (
    /(@license|@preserve)/i.test(comment) ||
    comment.startsWith("/*!")
  );
}

function getEcmaTarget(
  environment?: Record<string, boolean | undefined>,
): string {
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
