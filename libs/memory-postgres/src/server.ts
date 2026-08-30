/**
 * Server-only entrypoint.  It intentionally re-exports the vendor-neutral
 * adapter; applications provide their own pg Pool/Client at runtime so the
 * browser never receives a database driver.
 */
export * from "./index";
export * from "./driver";
