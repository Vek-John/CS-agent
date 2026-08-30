export function createInvoke(host = window) {
  const invoke = host.__TAURI_INTERNALS__?.invoke;
  if (typeof invoke !== "function") throw new Error("HOST_UNAVAILABLE");
  return (command, args = {}) => invoke(command, args);
}
