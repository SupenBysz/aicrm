import { createHash } from "node:crypto";
import { constants as fsConstants, type Stats } from "node:fs";
import { lstat, open, readdir } from "node:fs/promises";
import path from "node:path";

export const DESKTOP_CREDENTIAL_TREE_DIGEST_ALGORITHM =
  "aicrm-credential-tree-rfc8785-nfc-v1" as const;

const MAX_FILES = 4096;
const MAX_TOTAL_BYTES = 128 << 20;
const MAX_SAFE_SIZE = Number.MAX_SAFE_INTEGER;

export type DesktopCredentialTreeErrorCode =
  | "desktop_credential_path_invalid"
  | "desktop_credential_tree_unsafe"
  | "desktop_credential_tree_changed";

export class DesktopCredentialTreeError extends Error {
  readonly code: DesktopCredentialTreeErrorCode;

  constructor(code: DesktopCredentialTreeErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

export interface DesktopCredentialTreeManifestEntry {
  path: string;
  sha256: string;
  size: number;
}

export interface DesktopCredentialTreeDigest {
  algorithm: typeof DESKTOP_CREDENTIAL_TREE_DIGEST_ALGORITHM;
  digest: string;
  fileCount: number;
  totalBytes: number;
}

/** Computes the locked RFC 8785/NFC digest after two stable tree scans. */
export async function digestDesktopCredentialTree(root: string): Promise<DesktopCredentialTreeDigest> {
  const absolute = path.resolve(root);
  if (absolute === path.parse(absolute).root) {
    throw treeError("desktop_credential_path_invalid", "凭据树根路径无效");
  }
  const first = await scanCredentialTree(absolute);
  const second = await scanCredentialTree(absolute);
  const firstCanonical = canonicalManifest(first.entries);
  const secondCanonical = canonicalManifest(second.entries);
  if (
    firstCanonical !== secondCanonical ||
    first.totalBytes !== second.totalBytes ||
    first.entries.length !== second.entries.length
  ) {
    throw treeError("desktop_credential_tree_changed", "凭据树在摘要期间发生变化");
  }
  return {
    algorithm: DESKTOP_CREDENTIAL_TREE_DIGEST_ALGORITHM,
    digest: sha256Hex(Buffer.from(secondCanonical, "utf8")),
    fileCount: second.entries.length,
    totalBytes: second.totalBytes
  };
}

export function canonicalDesktopCredentialManifest(
  entries: readonly DesktopCredentialTreeManifestEntry[]
): string {
  return canonicalManifest(entries);
}

async function scanCredentialTree(
  root: string
): Promise<{ entries: DesktopCredentialTreeManifestEntry[]; totalBytes: number }> {
  const rootInfo = await safeLstat(root);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
    throw treeError("desktop_credential_tree_unsafe", "凭据树根目录不安全");
  }
  const entries: DesktopCredentialTreeManifestEntry[] = [];
  const normalizedNodes = new Map<string, { rawPath: string; directory: boolean }>();
  let totalBytes = 0;

  const visit = async (
    directory: string,
    relativeSegments: string[],
    expected: Stats
  ): Promise<void> => {
    const before = await safeLstat(directory);
    if (
      !before.isDirectory() ||
      before.isSymbolicLink() ||
      before.dev !== expected.dev ||
      before.ino !== expected.ino
    ) {
      throw treeError("desktop_credential_tree_changed", "凭据目录在枚举前发生变化");
    }
    let children;
    try {
      children = await readdir(directory, { withFileTypes: true, encoding: "buffer" });
    } catch {
      throw treeError("desktop_credential_tree_unsafe", "凭据树目录无法枚举");
    }
    for (const child of children) {
      const name = decodeFilename(child.name);
      if (name === "" || name === "." || name === ".." || name.includes("/")) {
        throw treeError("desktop_credential_tree_unsafe", "凭据树文件名无效");
      }
      const rawSegments = [...relativeSegments, name];
      const rawPath = rawSegments.join("/");
      const normalizedPath = rawPath.normalize("NFC");
      validateRelativePath(normalizedPath);
      const childPath = path.join(directory, name);
      const metadata = await safeLstat(childPath);
      if (metadata.isSymbolicLink()) {
        throw treeError("desktop_credential_tree_unsafe", "凭据树禁止符号链接");
      }
      const directoryNode = metadata.isDirectory();
      const previous = normalizedNodes.get(normalizedPath);
      if (
        previous &&
        (previous.rawPath !== rawPath || previous.directory !== directoryNode)
      ) {
        throw treeError("desktop_credential_tree_unsafe", "凭据树 NFC 路径发生冲突");
      }
      normalizedNodes.set(normalizedPath, { rawPath, directory: directoryNode });
      if (directoryNode) {
        await visit(childPath, rawSegments, metadata);
        continue;
      }
      if (!metadata.isFile() || metadata.nlink !== 1) {
        throw treeError("desktop_credential_tree_unsafe", "凭据树只允许单链接普通文件");
      }
      if (
        !Number.isSafeInteger(metadata.size) ||
        metadata.size < 0 ||
        metadata.size > MAX_SAFE_SIZE ||
        metadata.size > MAX_TOTAL_BYTES ||
        entries.length >= MAX_FILES ||
        totalBytes + metadata.size > MAX_TOTAL_BYTES
      ) {
        throw treeError("desktop_credential_tree_unsafe", "凭据树超过安全上限");
      }
      totalBytes += metadata.size;
      const file = await digestStableFile(childPath, metadata);
      if (file.size !== metadata.size) {
        throw treeError("desktop_credential_tree_changed", "凭据文件大小不稳定");
      }
      entries.push({ path: normalizedPath, sha256: file.sha256, size: file.size });
    }
    const after = await safeLstat(directory);
    if (!after.isDirectory() || after.isSymbolicLink() || !sameFileState(before, after)) {
      throw treeError("desktop_credential_tree_changed", "凭据目录在枚举期间发生变化");
    }
  };

  await visit(root, [], rootInfo);
  entries.sort((left, right) => Buffer.compare(Buffer.from(left.path, "utf8"), Buffer.from(right.path, "utf8")));
  return { entries, totalBytes };
}

async function digestStableFile(
  file: string,
  expected: Stats
): Promise<{ size: number; sha256: string }> {
  const flags = fsConstants.O_RDONLY | (process.platform === "win32" ? 0 : fsConstants.O_NOFOLLOW);
  let handle;
  try {
    handle = await open(file, flags);
    const before = await handle.stat();
    if (
      !before.isFile() ||
      before.nlink !== 1 ||
      before.dev !== expected.dev ||
      before.ino !== expected.ino ||
      before.mode !== expected.mode ||
      before.nlink !== expected.nlink ||
      before.size !== expected.size ||
      !Number.isSafeInteger(before.size) ||
      before.size < 0 ||
      before.size > MAX_SAFE_SIZE ||
      before.size > MAX_TOTAL_BYTES
    ) {
      throw treeError("desktop_credential_tree_unsafe", "凭据文件不安全");
    }
    const content = await handle.readFile();
    const after = await handle.stat();
    if (content.byteLength !== before.size || !sameFileState(before, after)) {
      throw treeError("desktop_credential_tree_changed", "凭据文件在读取期间发生变化");
    }
    return { size: content.byteLength, sha256: sha256Hex(content) };
  } catch (error) {
    if (error instanceof DesktopCredentialTreeError) throw error;
    throw treeError("desktop_credential_tree_unsafe", "凭据文件无法安全读取");
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function canonicalManifest(entries: readonly DesktopCredentialTreeManifestEntry[]): string {
  const normalized = entries.map((entry) => ({ ...entry }));
  const paths = new Set<string>();
  for (const entry of normalized) {
    validateRelativePath(entry.path);
    if (paths.has(entry.path)) {
      throw treeError("desktop_credential_tree_unsafe", "凭据摘要清单路径发生冲突");
    }
    paths.add(entry.path);
  }
  normalized.sort((left, right) =>
    Buffer.compare(Buffer.from(left.path, "utf8"), Buffer.from(right.path, "utf8"))
  );
  return `[${normalized
    .map((entry) => {
      if (!Number.isSafeInteger(entry.size) || entry.size < 0 || !/^[0-9a-f]{64}$/.test(entry.sha256)) {
        throw treeError("desktop_credential_tree_unsafe", "凭据摘要清单字段无效");
      }
      return `{"path":${JSON.stringify(entry.path)},"sha256":"${entry.sha256}","size":${entry.size}}`;
    })
    .join(",")}]`;
}

function validateRelativePath(value: string): void {
  if (value === "" || value.startsWith("/") || value !== value.normalize("NFC")) {
    throw treeError("desktop_credential_tree_unsafe", "凭据相对路径无效");
  }
  for (const segment of value.split("/")) {
    if (segment === "" || segment === "." || segment === "..") {
      throw treeError("desktop_credential_tree_unsafe", "凭据相对路径无效");
    }
  }
}

function decodeFilename(value: Buffer | string): string {
  if (typeof value === "string") {
    if (value.includes("\ufffd")) {
      throw treeError("desktop_credential_tree_unsafe", "凭据文件名不是有效 UTF-8");
    }
    return value;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(value);
  } catch {
    throw treeError("desktop_credential_tree_unsafe", "凭据文件名不是有效 UTF-8");
  }
}

function sameFileState(left: Stats, right: Stats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.nlink === right.nlink &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  );
}

async function safeLstat(target: string) {
  try {
    return await lstat(target);
  } catch {
    throw treeError("desktop_credential_path_invalid", "凭据路径不存在或不可访问");
  }
}

function sha256Hex(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function treeError(code: DesktopCredentialTreeErrorCode, message: string): DesktopCredentialTreeError {
  return new DesktopCredentialTreeError(code, message);
}
