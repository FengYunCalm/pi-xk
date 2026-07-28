import { type KeybindingsManager, type Theme, truncateToVisualLines } from "@earendil-works/pi-coding-agent";

export type GoalDraftReviewAction = "confirm" | "revise" | "cancel";

interface GoalDraftReviewTui {
	terminal: { rows: number };
	requestRender(): void;
}

export interface GoalDraftReviewComponent {
	render(width: number): string[];
	invalidate(): void;
	handleInput(data: string): void;
}

export interface GoalDraftReviewComponentOptions {
	markdown: string;
	title?: string;
	confirmLabel?: string;
	reviseLabel?: string;
	tui: GoalDraftReviewTui;
	theme: Theme;
	keybindings: KeybindingsManager;
	done: (result: GoalDraftReviewAction) => void;
}

function dialogMarkdown(markdown: string): string {
	return markdown.replace(/^# Goal (?:Draft|Revision)(?:\r?\n)+/, "");
}

function styleDraftLine(line: string, theme: Theme): string {
	const heading = /^(#{1,6})\s+(.*)$/.exec(line);
	if (heading) return theme.fg("accent", theme.bold(heading[2] ?? ""));
	if (line.startsWith("- ")) return `${theme.fg("muted", "• ")}${theme.fg("text", line.slice(2))}`;
	return theme.fg("text", line);
}

export function createGoalDraftReviewComponent(options: GoalDraftReviewComponentOptions): GoalDraftReviewComponent {
	const actions: ReadonlyArray<{ action: Exclude<GoalDraftReviewAction, "cancel">; label: string }> = [
		{ action: "confirm", label: options.confirmLabel ?? "确认，启动 Goal" },
		{ action: "revise", label: options.reviseLabel ?? "修改草案" },
	];
	let selectedIndex = 0;
	let scrollOffset = 0;
	let bodyPageSize = 1;
	let maxScrollOffset = 0;

	const refresh = (): void => options.tui.requestRender();

	const handleInput = (data: string): void => {
		if (options.keybindings.matches(data, "tui.select.pageUp")) {
			scrollOffset = Math.max(0, scrollOffset - bodyPageSize);
			refresh();
			return;
		}
		if (options.keybindings.matches(data, "tui.select.pageDown")) {
			scrollOffset = Math.min(maxScrollOffset, scrollOffset + bodyPageSize);
			refresh();
			return;
		}
		if (options.keybindings.matches(data, "tui.select.up")) {
			selectedIndex = Math.max(0, selectedIndex - 1);
			refresh();
			return;
		}
		if (options.keybindings.matches(data, "tui.select.down")) {
			selectedIndex = Math.min(actions.length - 1, selectedIndex + 1);
			refresh();
			return;
		}
		if (options.keybindings.matches(data, "tui.select.confirm")) {
			const selected = actions[selectedIndex];
			if (selected) options.done(selected.action);
			return;
		}
		if (options.keybindings.matches(data, "tui.select.cancel")) {
			options.done("cancel");
		}
	};

	const render = (width: number): string[] => {
		const renderWidth = Math.max(1, width);
		const contentWidth = Math.max(1, renderWidth - 2);
		const availableRows = Math.max(1, options.tui.terminal.rows);
		const fullLayout = availableRows >= 10;
		const compactLayout = availableRows >= 6 && !fullLayout;
		bodyPageSize = fullLayout
			? availableRows - 9
			: compactLayout
				? availableRows - 5
				: Math.max(0, availableRows - 3);
		const markdown = dialogMarkdown(options.markdown);
		const bodyLines = truncateToVisualLines(markdown, Math.max(1, markdown.length + 1), contentWidth).visualLines;
		maxScrollOffset = Math.max(0, bodyLines.length - bodyPageSize);
		scrollOffset = Math.min(scrollOffset, maxScrollOffset);
		const visibleBody = bodyLines.slice(scrollOffset, scrollOffset + bodyPageSize);
		const bodyEnd = Math.min(bodyLines.length, scrollOffset + visibleBody.length);
		const overflow =
			bodyLines.length > bodyPageSize
				? options.theme.fg("dim", ` · ${scrollOffset + 1}-${bodyEnd}/${bodyLines.length}`)
				: "";
		const border = options.theme.fg("accent", "─".repeat(renderWidth));
		const title = ` ${options.theme.fg("accent", options.theme.bold(options.title ?? "Goal Draft"))}${overflow}`;
		const actionLines = actions.map((action, index) => {
			const selected = index === selectedIndex;
			const prefix = selected ? options.theme.fg("accent", "> ") : "  ";
			return `${prefix}${options.theme.fg(selected ? "accent" : "text", action.label)}`;
		});
		if (!fullLayout && !compactLayout) {
			if (availableRows === 1) return [actionLines[selectedIndex] ?? actionLines[0] ?? ""];
			const lines = availableRows >= 3 ? [title] : [];
			for (const line of visibleBody) lines.push(` ${styleDraftLine(line, options.theme)}`);
			lines.push(...actionLines);
			return lines;
		}

		const lines = [border, title];
		if (fullLayout) lines.push("");
		for (const line of visibleBody) lines.push(` ${styleDraftLine(line, options.theme)}`);
		if (fullLayout) lines.push("");
		lines.push(...actionLines);
		if (fullLayout) lines.push("", ` ${options.theme.fg("dim", "PgUp/PgDn 滚动 · ↑↓ 选择 · Enter 确认 · Esc 取消")}`);
		lines.push(border);
		return lines;
	};

	return {
		render,
		invalidate: () => {},
		handleInput,
	};
}
