import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          // MUI 9 removed system props: Typography matches `color` only against palette keys
          // and textPrimary/textSecondary/textDisabled, so a dotted path renders no color.
          // sx resolves theme paths on every component.
          selector: "JSXAttribute[name.name='color'] Literal[value=/\\./]",
          message: "Put theme color paths in sx, for example sx={{ color: \"text.secondary\" }}. MUI 9 Typography ignores them in the color prop.",
        },
      ],
    },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
]);

export default eslintConfig;
