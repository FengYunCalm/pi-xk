import { createHash, randomUUID } from "node:crypto";
import { type FileHandle, link, mkdir, open, readFile, stat, unlink } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import {
	GOAL_ARTIFACT_SCHEMA,
	type GoalArtifactContentType,
	type GoalArtifactMetadata,
	type GoalArtifactSensitivity,
	GoalValidationError,
} from "./contract.ts";
import { stableJsonStringify } from "./stable-json.ts";
import { syncDirectory } from "./sync-directory.ts";

export const ARTIFACT_REDACTION_VERSION = "pi-xk.redaction.v1";

export const MAX_ARTIFACT_BYTES = 64 * 1024;

export type ArtifactWritePhase =
	| "data_fsync"
	| "data_publish"
	| "data_directory_sync"
	| "metadata_fsync"
	| "metadata_publish"
	| "metadata_directory_sync";

export interface ArtifactStoreOptions {
	/** Test-only fault injection point for the durable object publication boundaries. */
	onWritePhase?: (phase: ArtifactWritePhase) => void | Promise<void>;
}

const ARTIFACT_ID_PREFIX = "sha256:";

const ARTIFACT_ID_PATTERN = /^sha256:[a-f0-9]{64}$/;

const ARTIFACT_TOKEN_PATTERN =
	/\b(?:sk-(?:ant-)?[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9_]{8,}|AIza[A-Za-z0-9_-]{8,}|AKIA[A-Z0-9]{8,})\b/g;

const ARTIFACT_BEARER_PATTERN = /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi;

const ARTIFACT_SECRET_ASSIGNMENT_PATTERN =
	/(["']?(?:api[_-]?key|token|secret|password|authorization)["']?\s*[:=]\s*["']?)([^"',\s}\]]+)/gi;

export class ArtifactStoreError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ArtifactStoreError";
	}
}

export class ArtifactInputError extends ArtifactStoreError {
	constructor(message: string) {
		super(message);
		this.name = "ArtifactInputError";
	}
}

export class ArtifactValidationError extends ArtifactStoreError {
	constructor(message: string) {
		super(message);
		this.name = "ArtifactValidationError";
	}
}

export class ArtifactNotFoundError extends ArtifactStoreError {
	constructor(artifactId: string) {
		super(`Artifact not found: ${artifactId}`);
		this.name = "ArtifactNotFoundError";
	}
}

export class ArtifactCorruptionError extends ArtifactStoreError {
	constructor(message: string) {
		super(message);
		this.name = "ArtifactCorruptionError";
	}
}

interface ArtifactWriteCommon {
	producer: string;
	sensitivity: GoalArtifactSensitivity;
	sourceIds: readonly string[];
	createdAt: string;
}

export type ArtifactWriteInput =
	| (ArtifactWriteCommon & { contentType: "application/json"; value: unknown })
	| (ArtifactWriteCommon & { contentType: "text/plain"; text: string });

export interface ArtifactReadResult {
	metadata: GoalArtifactMetadata;
	content: string;
}

interface ArtifactPaths {
	objectDirectory: string;
	dataPath: string;
	metadataPath: string;
}

interface RedactionResult {
	content: string;
	replacements: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isErrno(error: unknown, code: string): boolean {
	return isRecord(error) && error.code === code;
}

function assertNonEmptyString(value: string, field: string): void {
	if (value.trim().length === 0) {
		throw new ArtifactValidationError(`${field} must be a non-empty string`);
	}
}

function assertIsoTimestamp(value: string, field: string): void {
	assertNonEmptyString(value, field);
	if (Number.isNaN(Date.parse(value))) {
		throw new ArtifactValidationError(`${field} must be an ISO timestamp`);
	}
}

function assertContentType(value: string): asserts value is GoalArtifactContentType {
	if (value !== "application/json" && value !== "text/plain") {
		throw new ArtifactValidationError("artifact contentType is unsupported");
	}
}

function assertSensitivity(value: string): asserts value is GoalArtifactSensitivity {
	if (value !== "internal" && value !== "redacted") {
		throw new ArtifactValidationError("artifact sensitivity is unsupported");
	}
}

function assertArtifactText(value: string): void {
	if (value.includes("\0")) {
		throw new ArtifactInputError("artifact content must not contain NUL bytes");
	}
	if (Buffer.byteLength(value) > MAX_ARTIFACT_BYTES) {
		throw new ArtifactInputError(`artifact content exceeds ${MAX_ARTIFACT_BYTES} bytes`);
	}
}

function assertSourceIds(value: readonly string[]): string[] {
	if (value.length === 0) {
		throw new ArtifactValidationError("artifact sourceIds must not be empty");
	}
	const sourceIds: string[] = [];
	const seen = new Set<string>();
	for (const sourceId of value) {
		assertNonEmptyString(sourceId, "artifact sourceIds entry");
		if (seen.has(sourceId)) {
			throw new ArtifactValidationError("artifact sourceIds must be unique");
		}
		seen.add(sourceId);
		sourceIds.push(sourceId);
	}
	return sourceIds;
}

export function assertArtifactId(artifactId: string): void {
	if (!ARTIFACT_ID_PATTERN.test(artifactId)) {
		throw new ArtifactValidationError("artifactId must use the sha256:<lowercase-hex> format");
	}
}

function digestForContent(content: string): string {
	return `${ARTIFACT_ID_PREFIX}${createHash("sha256").update(content, "utf8").digest("hex")}`;
}

function replaceWithCount(
	content: string,
	pattern: RegExp,
	replacement: (match: string, ...groups: string[]) => string,
): RedactionResult {
	let replacements = 0;
	const redacted = content.replace(pattern, (match, ...groups: string[]) => {
		replacements += 1;
		return replacement(match, ...groups);
	});
	return { content: redacted, replacements };
}

export function redactArtifactText(content: string): RedactionResult {
	let total = 0;
	let result = replaceWithCount(content, ARTIFACT_BEARER_PATTERN, () => "Bearer [REDACTED]");
	total += result.replacements;
	result = replaceWithCount(result.content, ARTIFACT_TOKEN_PATTERN, () => "[REDACTED]");
	total += result.replacements;
	result = replaceWithCount(
		result.content,
		ARTIFACT_SECRET_ASSIGNMENT_PATTERN,
		(_match, prefix) => `${prefix}[REDACTED]`,
	);
	total += result.replacements;
	return { content: result.content, replacements: total };
}

function requireExactKeys(value: Record<string, unknown>, keys: readonly string[], field: string): void {
	const actual = Object.keys(value).sort();
	const expected = [...keys].sort();
	if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
		throw new ArtifactCorruptionError(`${field} has unknown or missing fields`);
	}
}

export function validateArtifactMetadata(value: unknown): GoalArtifactMetadata {
	if (!isRecord(value)) {
		throw new ArtifactCorruptionError("artifact metadata must be an object");
	}
	requireExactKeys(
		value,
		[
			"schema",
			"artifactId",
			"contentType",
			"bytes",
			"createdAt",
			"producer",
			"sensitivity",
			"redactionVersion",
			"sourceIds",
		],
		"artifact metadata",
	);
	if (value.schema !== GOAL_ARTIFACT_SCHEMA) {
		throw new ArtifactCorruptionError("artifact metadata has an unsupported schema");
	}
	if (typeof value.artifactId !== "string") {
		throw new ArtifactCorruptionError("artifact metadata has an invalid artifactId");
	}
	try {
		assertArtifactId(value.artifactId);
		if (typeof value.contentType !== "string") throw new ArtifactValidationError("artifact contentType is invalid");
		assertContentType(value.contentType);
		if (typeof value.bytes !== "number" || !Number.isInteger(value.bytes) || value.bytes < 0) {
			throw new ArtifactValidationError("artifact bytes must be a non-negative integer");
		}
		if (typeof value.createdAt !== "string") throw new ArtifactValidationError("artifact createdAt is invalid");
		assertIsoTimestamp(value.createdAt, "artifact createdAt");
		if (typeof value.producer !== "string") throw new ArtifactValidationError("artifact producer is invalid");
		assertNonEmptyString(value.producer, "artifact producer");
		if (typeof value.sensitivity !== "string") throw new ArtifactValidationError("artifact sensitivity is invalid");
		assertSensitivity(value.sensitivity);
		if (typeof value.redactionVersion !== "string") {
			throw new ArtifactValidationError("artifact redactionVersion is invalid");
		}
		assertNonEmptyString(value.redactionVersion, "artifact redactionVersion");
		if (!Array.isArray(value.sourceIds) || value.sourceIds.some((sourceId) => typeof sourceId !== "string")) {
			throw new ArtifactValidationError("artifact sourceIds must be a string array");
		}
		return {
			schema: GOAL_ARTIFACT_SCHEMA,
			artifactId: value.artifactId,
			contentType: value.contentType,
			bytes: value.bytes,
			createdAt: value.createdAt,
			producer: value.producer,
			sensitivity: value.sensitivity,
			redactionVersion: value.redactionVersion,
			sourceIds: assertSourceIds(value.sourceIds),
		};
	} catch (error) {
		if (error instanceof ArtifactCorruptionError) throw error;
		throw new ArtifactCorruptionError(error instanceof Error ? error.message : "artifact metadata is invalid");
	}
}

function contentForInput(input: ArtifactWriteInput): string {
	if (input.contentType === "text/plain") {
		if (typeof input.text !== "string") {
			throw new ArtifactInputError("text/plain artifacts require string text");
		}
		return input.text;
	}
	try {
		return stableJsonStringify(input.value);
	} catch (error) {
		if (error instanceof GoalValidationError) {
			throw new ArtifactInputError(error.message);
		}
		throw error;
	}
}

function validateWriteInput(input: ArtifactWriteInput): { content: string; sourceIds: string[] } {
	assertContentType(input.contentType);
	assertNonEmptyString(input.producer, "artifact producer");
	assertSensitivity(input.sensitivity);
	assertIsoTimestamp(input.createdAt, "artifact createdAt");
	const sourceIds = assertSourceIds(input.sourceIds);
	const content = contentForInput(input);
	assertArtifactText(content);
	return { content, sourceIds };
}

export class ArtifactStore {
	private readonly artifactsDirectory: string;
	private readonly onWritePhase: ((phase: ArtifactWritePhase) => void | Promise<void>) | undefined;

	constructor(projectRoot: string, options: ArtifactStoreOptions = {}) {
		this.artifactsDirectory = join(resolve(projectRoot), ".pi-xk", "artifacts");
		this.onWritePhase = options.onWritePhase;
	}

	private paths(artifactId: string): ArtifactPaths {
		assertArtifactId(artifactId);
		const digest = artifactId.slice(ARTIFACT_ID_PREFIX.length);
		const objectDirectory = join(this.artifactsDirectory, "objects", digest.slice(0, 2));
		const dataPath = join(objectDirectory, `${digest}.data`);
		const metadataPath = join(objectDirectory, `${digest}.json`);
		if (basename(dataPath) !== `${digest}.data` || basename(metadataPath) !== `${digest}.json`) {
			throw new ArtifactValidationError("artifactId resolves outside the artifact directory");
		}
		return { objectDirectory, dataPath, metadataPath };
	}

	private async publishIfAbsent(path: string, content: string, kind: "data" | "metadata"): Promise<boolean> {
		const directory = dirname(path);
		const temporaryPath = join(directory, `.${basename(path)}-${randomUUID()}.tmp`);
		let handle: FileHandle | undefined;
		let linked = false;
		try {
			handle = await open(temporaryPath, "wx", 0o600);
			await handle.writeFile(content, "utf8");
			await this.onWritePhase?.(`${kind}_fsync`);
			await handle.sync();
			await handle.close();
			handle = undefined;
			try {
				await this.onWritePhase?.(`${kind}_publish`);
				await link(temporaryPath, path);
				linked = true;
				await this.onWritePhase?.(`${kind}_directory_sync`);
				await syncDirectory(directory);
			} catch (error) {
				if (!isErrno(error, "EEXIST")) throw error;
			}
			return linked;
		} finally {
			await handle?.close().catch(() => {});
			await unlink(temporaryPath).catch(() => {});
		}
	}

	private async readStored(artifactId: string): Promise<ArtifactReadResult> {
		const paths = this.paths(artifactId);
		let content: string | undefined;
		let metadataContent: string | undefined;
		let dataMissing = false;
		let metadataMissing = false;
		try {
			content = await readFile(paths.dataPath, "utf8");
		} catch (error) {
			if (isErrno(error, "ENOENT")) dataMissing = true;
			else throw error;
		}
		try {
			metadataContent = await readFile(paths.metadataPath, "utf8");
		} catch (error) {
			if (isErrno(error, "ENOENT")) metadataMissing = true;
			else throw error;
		}
		if (dataMissing && metadataMissing) throw new ArtifactNotFoundError(artifactId);
		if (dataMissing || metadataMissing || content === undefined || metadataContent === undefined) {
			throw new ArtifactCorruptionError(`artifact is incomplete: ${artifactId}`);
		}
		let metadata: GoalArtifactMetadata;
		try {
			metadata = validateArtifactMetadata(JSON.parse(metadataContent) as unknown);
		} catch (error) {
			if (error instanceof ArtifactCorruptionError) throw error;
			throw new ArtifactCorruptionError(`artifact metadata is not valid JSON: ${artifactId}`);
		}
		if (metadata.artifactId !== artifactId) {
			throw new ArtifactCorruptionError(`artifact metadata ID does not match its path: ${artifactId}`);
		}
		if (metadata.bytes !== Buffer.byteLength(content)) {
			throw new ArtifactCorruptionError(`artifact byte length does not match metadata: ${artifactId}`);
		}
		if (digestForContent(content) !== artifactId) {
			throw new ArtifactCorruptionError(`artifact content hash does not match its ID: ${artifactId}`);
		}
		return { metadata, content };
	}

	private async completeDataOnlyArtifact(
		paths: ArtifactPaths,
		artifactId: string,
		content: string,
		metadataContent: string,
	): Promise<boolean> {
		let existingContent: string;
		try {
			existingContent = await readFile(paths.dataPath, "utf8");
		} catch (error) {
			if (isErrno(error, "ENOENT")) return false;
			throw error;
		}
		try {
			await readFile(paths.metadataPath, "utf8");
			return false;
		} catch (error) {
			if (!isErrno(error, "ENOENT")) throw error;
		}
		if (existingContent !== content || digestForContent(existingContent) !== artifactId) {
			return false;
		}
		await this.publishIfAbsent(paths.metadataPath, metadataContent, "metadata");
		return true;
	}

	async put(input: ArtifactWriteInput): Promise<GoalArtifactMetadata> {
		const validated = validateWriteInput(input);
		const redacted = redactArtifactText(validated.content);
		assertArtifactText(redacted.content);
		const artifactId = digestForContent(redacted.content);
		const metadata: GoalArtifactMetadata = {
			schema: GOAL_ARTIFACT_SCHEMA,
			artifactId,
			contentType: input.contentType,
			bytes: Buffer.byteLength(redacted.content),
			createdAt: input.createdAt,
			producer: input.producer,
			sensitivity: input.sensitivity,
			redactionVersion: ARTIFACT_REDACTION_VERSION,
			sourceIds: validated.sourceIds,
		};
		const metadataContent = `${stableJsonStringify(metadata)}\n`;
		const paths = this.paths(artifactId);
		try {
			return (await this.readStored(artifactId)).metadata;
		} catch (error) {
			if (error instanceof ArtifactCorruptionError) {
				if (await this.completeDataOnlyArtifact(paths, artifactId, redacted.content, metadataContent)) {
					return (await this.readStored(artifactId)).metadata;
				}
				throw error;
			}
			if (!(error instanceof ArtifactNotFoundError)) throw error;
		}
		await mkdir(paths.objectDirectory, { recursive: true });
		await this.publishIfAbsent(paths.dataPath, redacted.content, "data");
		await this.publishIfAbsent(paths.metadataPath, metadataContent, "metadata");
		return (await this.readStored(artifactId)).metadata;
	}

	async read(artifactId: string, maxBytes = MAX_ARTIFACT_BYTES): Promise<ArtifactReadResult> {
		if (!Number.isInteger(maxBytes) || maxBytes < 0 || maxBytes > MAX_ARTIFACT_BYTES) {
			throw new ArtifactValidationError(`maxBytes must be between 0 and ${MAX_ARTIFACT_BYTES}`);
		}
		const paths = this.paths(artifactId);
		let size: number;
		try {
			size = (await stat(paths.dataPath)).size;
		} catch (error) {
			if (isErrno(error, "ENOENT")) return await this.readStored(artifactId);
			throw error;
		}
		if (size > maxBytes) {
			throw new ArtifactInputError(`artifact exceeds requested read limit: ${artifactId}`);
		}
		return await this.readStored(artifactId);
	}
}
