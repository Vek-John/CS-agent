import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
} from "node:fs";
import { open } from "node:fs/promises";
import { isAbsolute, join, posix, resolve, sep, win32 } from "node:path";

export type LibraryPathErrorCode =
  | "INVALID_RELATIVE_PATH"
  | "SYMLINK_ESCAPE";

export class LibraryPathError extends Error {
  constructor(readonly code: LibraryPathErrorCode) {
    super(code);
    this.name = "LibraryPathError";
  }
}

function rejectSymlinks(root: string, parts: readonly string[]): void {
  let cursor = root;
  for (const part of parts) {
    cursor = join(cursor, part);
    if (!existsSync(cursor)) break;
    if (lstatSync(cursor).isSymbolicLink())
      throw new LibraryPathError("SYMLINK_ESCAPE");
  }
}

export class LibraryPathPolicy {
  readonly dataRoot: string;
  readonly libraryRoot: string;
  readonly demosRoot: string;
  readonly artifactsRoot: string;
  readonly tmpRoot: string;

  constructor(dataRoot: string) {
    if (!dataRoot || !isAbsolute(dataRoot) || dataRoot.includes("\0"))
      throw new LibraryPathError("INVALID_RELATIVE_PATH");
    this.dataRoot = resolve(dataRoot);
    this.libraryRoot = join(this.dataRoot, "library");
    this.demosRoot = join(this.libraryRoot, "demos");
    this.artifactsRoot = join(this.libraryRoot, "artifacts");
    this.tmpRoot = join(this.libraryRoot, "tmp");
  }

  initialize(): void {
    for (const directory of [
      this.dataRoot,
      this.libraryRoot,
      this.demosRoot,
      this.artifactsRoot,
      this.tmpRoot,
    ]) {
      if (existsSync(directory) && lstatSync(directory).isSymbolicLink())
        throw new LibraryPathError("SYMLINK_ESCAPE");
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      chmodSync(directory, 0o700);
    }
  }

  relative(...parts: readonly string[]): string {
    return posix.join(...parts);
  }

  resolve(relativePath: string): string {
    if (
      !relativePath ||
      relativePath.includes("\0") ||
      relativePath.includes("\\") ||
      posix.isAbsolute(relativePath) ||
      win32.isAbsolute(relativePath)
    )
      throw new LibraryPathError("INVALID_RELATIVE_PATH");
    const parts = relativePath.split("/");
    if (
      parts.some((part) => !part || part === "." || part === "..") ||
      parts[0] !== "library"
    )
      throw new LibraryPathError("INVALID_RELATIVE_PATH");
    const absolute = resolve(this.dataRoot, ...parts);
    if (!absolute.startsWith(`${this.dataRoot}${sep}`))
      throw new LibraryPathError("INVALID_RELATIVE_PATH");
    rejectSymlinks(this.dataRoot, parts);
    return absolute;
  }

  ensureParent(relativePath: string): string {
    const absolute = this.resolve(relativePath);
    const parts = relativePath.split("/").slice(0, -1);
    let cursor = this.dataRoot;
    for (const part of parts) {
      cursor = join(cursor, part);
      if (existsSync(cursor) && lstatSync(cursor).isSymbolicLink())
        throw new LibraryPathError("SYMLINK_ESCAPE");
      if (!existsSync(cursor)) mkdirSync(cursor, { mode: 0o700 });
      chmodSync(cursor, 0o700);
    }
    return absolute;
  }

  async fsyncDirectory(absoluteDirectory: string): Promise<void> {
    const handle = await open(absoluteDirectory, "r");
    try {
      // Node 24's permission model rejects the synchronous fsync API even
      // when the directory is explicitly allow-listed. FileHandle.sync()
      // preserves the same durability barrier and remains permission-aware.
      await handle.sync();
    } finally {
      await handle.close();
    }
  }
}
