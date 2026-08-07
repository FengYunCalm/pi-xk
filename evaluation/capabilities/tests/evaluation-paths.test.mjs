import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import { isPathInsideRoot } from "../../../scripts/pi-xk-evaluation-paths.mjs";

const root = join(resolve("pi-xk-evaluation-path-fixture"), "repository");

assert.equal(isPathInsideRoot(root, join(root, "output")), true);
assert.equal(isPathInsideRoot(root, join(root, "..output")), true);
assert.equal(isPathInsideRoot(root, root), false);
assert.equal(isPathInsideRoot(root, resolve(root, "..")), false);
assert.equal(isPathInsideRoot(root, resolve(root, "..", "repository-sibling")), false);
