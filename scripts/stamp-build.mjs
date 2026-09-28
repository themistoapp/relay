// Stamps the build time next to the compiled server so /healthz can show exactly when the running
// image was built (tells "did my redeploy rebuild?" apart from "it's running a stale image").
import { writeFileSync } from "node:fs";
writeFileSync(new URL("../dist/build-time.txt", import.meta.url), new Date().toISOString().replace(/\.\d+Z$/, "Z") + "\n");
