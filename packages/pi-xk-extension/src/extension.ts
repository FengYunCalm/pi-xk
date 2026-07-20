import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createPiXkGoalExtension } from "./index.ts";

const goalExtension = createPiXkGoalExtension();

export default function piXkGoalExtension(pi: ExtensionAPI): void {
	goalExtension(pi);
}
