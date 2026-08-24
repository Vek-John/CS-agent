import { AsyncLocalStorage } from "node:async_hooks";
import { AsyncLocalStorageProviderSingleton } from "@langchain/core/singletons";

/** Install Cloudflare/nodejs_compat native ALS; never use the browser shim here. */
export function initializeCloudflareAsyncContext(): void {
  AsyncLocalStorageProviderSingleton.initializeGlobalInstance(new AsyncLocalStorage());
}
