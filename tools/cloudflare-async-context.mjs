import { initializeCloudflareAsyncContext } from "../libs/coach-agent/src/cloudflare-async-context.ts";

// Cloudflare's nodejs_compat runtime provides the native async context
// implementation required by LangGraph. This module is intentionally not the
// browser single-flight shim from libs/coach-agent.
initializeCloudflareAsyncContext();
