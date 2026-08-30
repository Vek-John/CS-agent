import { afterEach, describe, expect, it, vi } from "vitest";

const jobs = vi.hoisted(() => ({
  create: vi.fn(),
  get: vi.fn(),
  start: vi.fn(),
}));

vi.mock("../../../lib/demo/local-demo-jobs", () => ({
  MAX_LOCAL_DEMO_BYTES: 512 * 1024 * 1024,
  createLocalDemoJob: jobs.create,
  getLocalDemoJob: jobs.get,
  startLocalDemoAnalysis: jobs.start,
}));

import { POST as upload } from "./route";
import { GET as getJob, POST as startAnalysis } from "./[id]/route";

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

describe("desktop local-demo boundary", () => {
  it("rejects upload before reading the request body or creating a job", async () => {
    vi.stubEnv("DEPLOY_TARGET", "desktop");
    const body = new ReadableStream({ pull: () => { throw new Error("BODY_MUST_NOT_BE_READ"); } });
    const request = new Request("http://127.0.0.1:43123/api/local-demo", {
      method: "POST",
      headers: { "x-demo-size": "64", "x-demo-name": "test.dem" },
      body,
      duplex: "half",
    } as RequestInit & { duplex: "half" });
    const response = await upload(request);
    expect(response.status).toBe(404);
    expect(request.bodyUsed).toBe(false);
    expect(jobs.create).not.toHaveBeenCalled();
  });

  it("rejects job reads and starts before resolving params or calling job functions", async () => {
    vi.stubEnv("DEPLOY_TARGET", "desktop");
    const context = { params: new Promise<{ id: string }>(() => undefined) };
    expect((await getJob(new Request("http://127.0.0.1:43123/api/local-demo/job"), context)).status).toBe(404);
    const startRequest = new Request("http://127.0.0.1:43123/api/local-demo/job", {
      method: "POST", body: JSON.stringify({ selected_player_id: "player" }),
    });
    expect((await startAnalysis(startRequest, context)).status).toBe(404);
    expect(startRequest.bodyUsed).toBe(false);
    expect(jobs.get).not.toHaveBeenCalled();
    expect(jobs.start).not.toHaveBeenCalled();
  });

  it("does not enable the desktop block from a public deploy variable", async () => {
    vi.stubEnv("DEPLOY_TARGET", "localhost");
    vi.stubEnv("NEXT_PUBLIC_DEPLOY_TARGET", "desktop");
    jobs.create.mockResolvedValue({ id: "job", status: "UPLOADED" });
    const response = await upload(new Request("http://localhost/api/local-demo", {
      method: "POST",
      headers: { "x-demo-size": "4", "x-demo-name": "a.dem" },
      body: new Uint8Array([1, 2, 3, 4]),
      duplex: "half",
    } as RequestInit & { duplex: "half" }));
    expect(response.status).toBe(201);
    expect(jobs.create).toHaveBeenCalledOnce();
  });
});
