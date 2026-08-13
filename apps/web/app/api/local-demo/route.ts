import { createLocalDemoJob, MAX_LOCAL_DEMO_BYTES } from "../../../lib/local-demo-jobs";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(request: Request) {
  try {
    const size = Number(request.headers.get("x-demo-size") ?? request.headers.get("content-length") ?? "0");
    if (!Number.isSafeInteger(size) || size <= 0) {
      return Response.json({ error: "Demo 文件大小无效。" }, { status: 400 });
    }
    if (size > MAX_LOCAL_DEMO_BYTES) {
      return Response.json({ error: "Demo 超过 localhost 版 512 MB 限制。" }, { status: 413 });
    }
    const encodedName = request.headers.get("x-demo-name");
    if (!encodedName || encodedName.length > 768 || !request.body) {
      return Response.json({ error: "请求中缺少 Demo 文件。" }, { status: 400 });
    }
    let name: string;
    try {
      name = decodeURIComponent(encodedName);
    } catch {
      return Response.json({ error: "Demo 文件名无效。" }, { status: 400 });
    }
    const body = request.body;
    const job = await createLocalDemoJob({ name, size, stream: () => body });
    return Response.json(job, { status: job.status === "FAILED" ? 422 : 201 });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message.trim() : "Demo 上传失败。" },
      { status: 400 }
    );
  }
}
