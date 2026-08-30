interface DownloadAnchor {
  href: string;
  download: string;
  click(): void;
  remove(): void;
}

export interface MemoryDownloadEnvironment {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
  createObjectUrl(blob: Blob): string;
  revokeObjectUrl(url: string): void;
  appendAnchor(anchor: DownloadAnchor): void;
  createAnchor(): DownloadAnchor;
}

function browserEnvironment(): MemoryDownloadEnvironment {
  return {
    fetch: (input, init) => fetch(input, init),
    createObjectUrl: (blob) => URL.createObjectURL(blob),
    revokeObjectUrl: (url) => URL.revokeObjectURL(url),
    appendAnchor: (anchor) => document.body.appendChild(anchor as HTMLAnchorElement),
    createAnchor: () => document.createElement("a"),
  };
}

function safeFilename(disposition: string | null): string {
  const match = disposition?.match(/filename="?([A-Za-z0-9._-]+)"?/u);
  const value = match?.[1];
  if (
    value &&
    value.startsWith("cs-agent-memory-export-") &&
    value.endsWith(".json")
  ) {
    return value;
  }
  return "cs-agent-memory-export.json";
}

export async function downloadMemoryExport(
  environment: MemoryDownloadEnvironment = browserEnvironment(),
): Promise<string> {
  const response = await environment.fetch("/api/memory/export", {
    method: "GET",
    credentials: "same-origin",
    headers: { accept: "application/json" },
  });
  if (!response.ok) {
    const payload = (await response.json().catch(() => ({}))) as {
      error?: string;
    };
    throw new Error(payload.error ?? `导出失败（${response.status}）`);
  }

  const filename = safeFilename(response.headers.get("content-disposition"));
  const url = environment.createObjectUrl(await response.blob());
  const anchor = environment.createAnchor();
  try {
    anchor.href = url;
    anchor.download = filename;
    environment.appendAnchor(anchor);
    anchor.click();
  } finally {
    anchor.remove();
    // WKWebView accepts a programmatic click on an attached anchor. Revoke
    // synchronously after dispatch so the object URL cannot accumulate.
    environment.revokeObjectUrl(url);
  }
  return filename;
}
