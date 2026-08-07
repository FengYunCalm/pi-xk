import { isAbsolute, relative, sep } from "node:path";

export function isPathInsideRoot(root, target) {
	const fromRoot = relative(root, target);
	return fromRoot !== "" && fromRoot !== ".." && !fromRoot.startsWith(`..${sep}`) && !isAbsolute(fromRoot);
}
