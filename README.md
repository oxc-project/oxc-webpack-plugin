# oxc-webpack-plugin

A webpack plugin that minifies JavaScript assets using [oxc-minify](https://www.npmjs.com/package/oxc-minify).

## Installation

```sh
npm install --save-dev oxc-webpack-plugin
```

## Usage

Disable webpack's default minimizer and use `OxcMinifyPlugin` instead:

```js
import { OxcMinifyPlugin } from "oxc-webpack-plugin";

export default {
  mode: "production",
  optimization: {
    minimize: true,
    minimizer: [new OxcMinifyPlugin()],
  },
};
```

By default the plugin minifies any asset matching `/\.[cm]?js(\?.*)?$/i` and
extracts legal comments (e.g. `@license`, `@preserve`, `/*!`) into a separate
`<asset>.LICENSE.txt` file with a link comment appended to the asset.

## Options

| Option            | Type                                          | Default                | Description                                                              |
| ----------------- | --------------------------------------------- | ---------------------- | ------------------------------------------------------------------------ |
| `test`            | `string \| RegExp \| Array<string \| RegExp>` | `/\.[cm]?js(\?.*)?$/i` | Match assets to minify.                                                  |
| `include`         | `string \| RegExp \| Array<string \| RegExp>` | —                      | Restrict matching to these assets.                                       |
| `exclude`         | `string \| RegExp \| Array<string \| RegExp>` | —                      | Exclude assets from minification.                                        |
| `extractComments` | `boolean`                                     | `true`                 | Extract legal comments into a sibling `.LICENSE.txt` file.               |
| `minifyOptions`   | `MinifyOptions`                               | `{}`                   | Forwarded to `oxc-minify`. See [oxc-minify options][oxc-minify-options]. |

### `extractComments`

When `true` (the default), legal comments are written to
`<asset>.LICENSE.txt` and a `//# sourceMappingURL`-style link is appended to
the minified asset. When `false`, legal comments are dropped entirely.

### `minifyOptions`

Forwarded to `oxc-minify`. The plugin sets sensible defaults that you can
override:

- `module` — inferred from webpack's `javascriptModule` asset info and the
  `.mjs` extension when not provided.
- `sourcemap` — inferred from webpack's `devtool` (enabled when it contains
  `source-map`) when not provided.
- `compress.target` — inferred from `output.environment` when not provided
  (e.g. `es2020` when `dynamicImport` / `module` are supported).
- `codegen.legalComments` — controlled by the `extractComments` option above.

[oxc-minify-options]: https://www.npmjs.com/package/oxc-minify

## License

MIT

# [Sponsored By](https://oxc.rs/sponsor)

<p align="center">
  <a href="https://oxc.rs/sponsor">
    <img src="https://raw.githubusercontent.com/oxc-project/sponsors/main/sponsors.svg" alt="Our sponsors" />
  </a>
</p>
