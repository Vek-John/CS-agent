import { getLocalDemoJob, startLocalDemoAnalysis } from "../../../../lib/demo/local-demo-jobs";

export const runtime = "nodejs";

type LocalDemoRouteContext = { params: Promise<{ id: string }> };

export async function GET(_request: Request, context: LocalDemoRouteContext) {
  if ((process.env.DEPLOY_TARGET ?? "").trim().toLowerCase() === "desktop") {
    return Response.json({ error: "DESKTOP_LOCAL_DEMO_DISABLED" }, { status: 404 });
  }
  const { id } = await context.params;
  const job = await getLocalDemoJob(id);
  return job
    ? Response.json(job, { headers: { "cache-control": "no-store" } })
    : Response.json({ error: "找不到这次 Demo 上传。" }, { status: 404 });
}

export async function POST(request: Request, context: LocalDemoRouteContext) {
  if ((process.env.DEPLOY_TARGET ?? "").trim().toLowerCase() === "desktop") {
    return Response.json({ error: "DESKTOP_LOCAL_DEMO_DISABLED" }, { status: 404 });
  }
  try {
    const { id } = await context.params;
    const payload = await request.json() as { selected_player_id?: unknown };
    if (typeof payload.selected_player_id !== "string" || !payload.selected_player_id.trim()) {
      return Response.json({ error: "请选择需要分析的玩家。" }, { status: 400 });
    }
    return Response.json(await startLocalDemoAnalysis(id, payload.selected_player_id));
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message.trim() : "无法开始分析。" },
      { status: 400 }
    );
  }
}
