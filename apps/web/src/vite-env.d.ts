/// <reference types="vite/client" />

// Vite resolves `import "./index.css"` at build time; TypeScript needs to be told that a CSS
// side-effect import is legitimate rather than a missing module.
declare module "*.css";
