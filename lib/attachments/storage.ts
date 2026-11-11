import { randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

export const WORKSPACE_ROOT = process.cwd();
export const DEFAULT_ATTACHMENT_STORAGE_ROOT = path.join(WORKSPACE_ROOT, "storage", "attachments");
export const ATTACHMENT_STORAGE_ROOT = process.env.ATTACHMENT_STORAGE_ROOT?.trim()
  ? path.resolve(process.env.ATTACHMENT_STORAGE_ROOT.trim())
  : DEFAULT_ATTACHMENT_STORAGE_ROOT;

function normalizeRelativePath(value: string) {
  return value.replace(/\\/g, "/");
}

export function relativeStoragePath(absolutePath: string) {
  return normalizeRelativePath(path.relative(ATTACHMENT_STORAGE_ROOT, absolutePath));
}

function safePathPart(value: string) {
  return value.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 160);
}

export function sanitizeOriginalFilename(value: string) {
  const base = path.basename(value || "attachment");
  const sanitized = safePathPart(base).replace(/_+/g, "_");
  return sanitized || "attachment";
}

export function buildAttachmentStorageTarget({
  segmentId,
  siteId,
  documentType,
  originalFilename,
}: {
  segmentId?: string | null;
  siteId?: string | null;
  documentType: string;
  originalFilename: string;
}) {
  const scope = segmentId ? "segments" : "sites";
  const scopeId = safePathPart(segmentId ?? siteId ?? "");
  // Defense-in-depth: every dynamic path segment is sanitized here, not just at
  // the call site. documentType is sanitized too (it was previously joined raw)
  // so a "../" value can never traverse out of the attachment storage root even
  // if a future caller forgets to validate it against the allowlist.
  const directory = path.join(ATTACHMENT_STORAGE_ROOT, scope, scopeId, safePathPart(documentType));
  const storedFilename = `${Date.now()}-${randomUUID()}-${sanitizeOriginalFilename(originalFilename)}`;
  const absolutePath = path.join(directory, storedFilename);
  return {
    directory,
    absolutePath,
    storedFilename,
    storagePath: relativeStoragePath(absolutePath),
  };
}

export function resolveAttachmentStoragePath(storagePath: string) {
  const storageRoot = path.resolve(ATTACHMENT_STORAGE_ROOT);
  const defaultStorageRoot = path.resolve(DEFAULT_ATTACHMENT_STORAGE_ROOT);
  const normalized = normalizeRelativePath(storagePath);
  const absolutePath = path.isAbsolute(storagePath)
    ? path.resolve(storagePath)
    : normalized.startsWith("storage/attachments/")
      ? path.resolve(WORKSPACE_ROOT, storagePath)
      : path.resolve(storageRoot, storagePath);
  const insideConfiguredRoot = absolutePath === storageRoot || absolutePath.startsWith(`${storageRoot}${path.sep}`);
  const insideLegacyRoot = normalized.startsWith("storage/attachments/")
    && (absolutePath === defaultStorageRoot || absolutePath.startsWith(`${defaultStorageRoot}${path.sep}`));
  const insideRoot = insideConfiguredRoot || insideLegacyRoot;
  if (!insideRoot) {
    throw new Error("Attachment storage path is outside the configured storage root.");
  }
  return absolutePath;
}

export async function writeUploadedFile(file: File, absolutePath: string) {
  await mkdir(path.dirname(absolutePath), { recursive: true });
  try {
    await pipeline(Readable.fromWeb(file.stream() as any), createWriteStream(absolutePath, { flags: "wx" }));
  } catch (error) {
    await rm(absolutePath, { force: true }).catch(() => undefined);
    throw error;
  }
}

export async function deleteStoredFile(storagePath: string) {
  const absolutePath = resolveAttachmentStoragePath(storagePath);
  try {
    await rm(absolutePath, { force: false });
    return { fileDeleted: true, fileMissing: false };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { fileDeleted: false, fileMissing: true };
    }
    throw error;
  }
}

export async function storedFileStat(storagePath: string) {
  const absolutePath = resolveAttachmentStoragePath(storagePath);
  const info = await stat(absolutePath);
  return { absolutePath, info };
}

export function storedFileStream(absolutePath: string) {
  return createReadStream(absolutePath);
}

export async function listStoredAttachmentFiles(root = ATTACHMENT_STORAGE_ROOT) {
  async function walk(directory: string): Promise<string[]> {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }

    const files: string[] = [];
    for (const entry of entries) {
      const absolutePath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        files.push(...await walk(absolutePath));
      } else if (entry.isFile()) {
        files.push(relativeStoragePath(absolutePath));
      }
    }
    return files.sort();
  }

  return walk(root);
}
