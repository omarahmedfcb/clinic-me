// @swc/jest does not read tsconfig.json's experimentalDecorators/emitDecoratorMetadata the way
// tsc does -- without this, it errors on any file using Nest decorators (@Injectable(), etc.)
// with a bare "Expression expected" syntax error, since decorator syntax is opt-in at the parser
// level. `legacyDecorator`/`decoratorMetadata` here are swc's names for the same two tsconfig
// options, kept in sync with tsconfig.json's compilerOptions on purpose.
const swcJestConfig = {
  jsc: {
    parser: { syntax: "typescript", decorators: true },
    transform: { legacyDecorator: true, decoratorMetadata: true },
  },
};

/** @type {import('jest').Config} */
module.exports = {
  projects: [
    {
      displayName: "unit",
      rootDir: __dirname,
      testEnvironment: "node",
      // `.mjs` so the unit project can reach the repo's own build tooling under `scripts/`, whose
      // behaviour is otherwise only ever observed by running a review build.
      transform: { "^.+\\.(ts|js|mjs)$": ["@swc/jest", swcJestConfig] },
      // jose ships ESM-only (no CJS build, as of v6) -- node_modules is excluded from
      // transformation by default, so Jest's own CJS-based module loader chokes on its `export`
      // syntax even though plain Node handles it fine via native require(esm) interop. This isn't
      // a production concern (the compiled build never goes through Jest), just a test-tooling one.
      transformIgnorePatterns: ["node_modules/(?!(jose)/)"],
      moduleFileExtensions: ["ts", "js", "mjs", "json"],
      // `test/unit` holds specs that are not about a single source file -- repo-wide conventions
      // that need a guardrail but have no ESLint rule available (see PHASE-1.md on TypeScript 7).
      testMatch: ["<rootDir>/src/**/*.spec.ts", "<rootDir>/test/unit/**/*.spec.ts"],
      setupFiles: ["<rootDir>/test/setup-unit-env.ts"],
    },
    {
      displayName: "integration",
      rootDir: __dirname,
      testEnvironment: "node",
      transform: { "^.+\\.(ts|js)$": ["@swc/jest", swcJestConfig] },
      transformIgnorePatterns: ["node_modules/(?!(jose)/)"],
      moduleFileExtensions: ["ts", "js", "json"],
      testMatch: ["<rootDir>/test/integration/**/*.integration.spec.ts"],
      setupFiles: ["<rootDir>/test/integration/setup-env.ts"],
      // `setupFilesAfterEnv`, not `setupFiles`: the latter runs before Jest's test framework is
      // installed, so `afterAll` is not defined there yet. This one closes each file's Prisma
      // client — see the file for what leaving it to each spec cost.
      setupFilesAfterEnv: ["<rootDir>/test/integration/disconnect-prisma.ts"],
      globalSetup: "<rootDir>/test/integration/globalSetup.ts",
    },
  ],
};
