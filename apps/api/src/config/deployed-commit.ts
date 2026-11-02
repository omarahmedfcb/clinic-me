// The commit this server runs: DEPLOYED_COMMIT, set at `docker compose up`, never a build ARG, because
// the release gate compares images and a stamp must not change one. Production refuses boot without it.
const FULL_SHA = /^[0-9a-f]{40}$/;

export function deployedCommit(env: NodeJS.ProcessEnv = process.env): string | null {
  const value = env["DEPLOYED_COMMIT"];
  if (value === undefined || value === "") {
    if (env["NODE_ENV"] === "production") {
      throw new Error("DEPLOYED_COMMIT is unset: start the API as DEPLOYED_COMMIT=$(git rev-parse HEAD) docker compose ... up (SERVER-SETUP.md §11)");
    }
    return null;
  }
  if (!FULL_SHA.test(value)) {
    throw new Error("DEPLOYED_COMMIT must be the full 40-character commit hash (git rev-parse HEAD), or unset");
  }
  return value;
}
