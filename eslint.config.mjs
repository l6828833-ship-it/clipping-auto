import globals from "globals";

export default [{
  files: ["dist/index.js", "server/**/*.mjs"],
  languageOptions: { globals: globals.nodeBuiltin },
  rules: { "no-undef": "error" },
}];
