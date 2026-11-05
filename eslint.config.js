import js from "@eslint/js";
import tseslint from "typescript-eslint";
import eslintComments from "@eslint-community/eslint-plugin-eslint-comments";
import react from "eslint-plugin-react";
import reactHooks from "eslint-plugin-react-hooks";

// One flat config for the whole workspace: the recommended rule sets plus
// the structural rules below. Those rules are here because reading this
// codebase found the problems they name — functions hundreds of lines
// long, nesting too deep to follow, type escapes that hide mistakes —
// so each one is a gate, not a preference.

// `as unknown as` is the double assertion: it opts out of the type
// system entirely, so it is banned outright rather than reviewed case
// by case.
const noUnknownAssertion = {
  selector: "TSAsExpression:has(> TSAsExpression > TSUnknownKeyword)",
  message:
    "`as unknown as` opts out of the type system. Type the value, or narrow it.",
};

const longFunction = (max) => [
  "error",
  { max, skipBlankLines: true, skipComments: true },
];

// The structural rules, one set shared by the daemon's sources
// and the view's, so the two packages cannot drift apart.
const structuralRules = {
  "max-lines-per-function": longFunction(60),
  "max-depth": ["error", 3],
  "no-nested-ternary": "error",
  "@typescript-eslint/no-explicit-any": "error",
  "no-restricted-syntax": ["error", noUnknownAssertion],
};

export default tseslint.config(
  { ignores: ["**/dist/**", "**/coverage/**", "**/node_modules/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    plugins: {
      "@eslint-community/eslint-comments": eslintComments,
    },
    rules: {
      // An exception carries its reason on the same line:
      // `// eslint-disable-next-line <rule> -- <reason>`. A disable
      // without the reason fails here.
      "@eslint-community/eslint-comments/require-description": "error",
    },
  },
  {
    files: [
      "packages/flightpath/src/**/*.ts",
      "packages/flightpath/scripts/**/*.mjs",
    ],
    rules: structuralRules,
  },
  {
    files: ["packages/flightpath/src/**/*.ts"],
    rules: {
      "@typescript-eslint/no-non-null-assertion": "error",
    },
  },
  {
    files: ["packages/flightpath/test/**/*.ts"],
    rules: {
      "max-depth": ["error", 3],
      "no-nested-ternary": "error",
      "@typescript-eslint/no-explicit-any": "error",
      "no-restricted-syntax": ["error", noUnknownAssertion],
    },
  },
  {
    files: ["packages/view/src/**/*.{ts,tsx}"],
    rules: {
      ...structuralRules,
      "@typescript-eslint/no-non-null-assertion": "error",
    },
  },
  {
    files: ["packages/view/src/**/*.tsx"],
    plugins: {
      react,
      "react-hooks": reactHooks,
    },
    settings: {
      react: { version: "detect" },
    },
    rules: {
      // The hooks rules are errors from the first component: a
      // conditional hook is a crash the type system cannot see.
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "error",
      "react/jsx-key": "error",
      // The automatic JSX runtime needs no React import in scope.
      "react/jsx-uses-react": "off",
      "react/react-in-jsx-scope": "off",
    },
  },
);
