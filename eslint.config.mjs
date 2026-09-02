import js from "@eslint/js"
import tseslint from "typescript-eslint"

/**
 * Flat config for the plugin's own sources and tests. `reportUnusedDisableDirectives` is the point
 * of having it at all: this package disables a handful of rules deliberately (the runtime
 * `require()`s of `@sap/cds`'s internal client modules, most of all), and those comments are only
 * trustworthy as long as something checks that they still describe a real finding.
 *
 * The type-aware rule set is deliberately not enabled: `npm run build` and `npm run typecheck`
 * already run the compiler over `src` and `test` with `strict`, so type-aware linting would mostly
 * repeat that at a multiple of the runtime.
 */
export default tseslint.config(
    { ignores: ["lib/", "sample/"] },
    js.configs.recommended,
    tseslint.configs.recommended,
    {
        // `cds-plugin.js` is the CommonJS entry point CAP's plugin loader requires - `require()` is
        // its only way to load anything, and not a style choice.
        files: ["**/*.js"],
        languageOptions: { sourceType: "commonjs" },
        rules: { "@typescript-eslint/no-require-imports": "off" }
    },
    {
        files: ["**/*.ts"],
        linterOptions: { reportUnusedDisableDirectives: "error" },
        rules: {
            // TypeScript resolves globals and identifiers itself, and does it better - the core rule
            // only produces false positives on a `tsc --strict` codebase.
            "no-undef": "off"
        }
    }
)
