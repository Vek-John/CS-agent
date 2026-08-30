import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { bindDesktopOriginPair, DesktopOriginBindError } from "./origins";

async function close(server: ReturnType<typeof createServer>): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

test("origin pair binds both sockets only to literal IPv4 loopback", async () => {
  const app = createServer();
  const viewer = createServer();
  try {
    const pair = await bindDesktopOriginPair(app, viewer);
    const appAddress = app.address() as AddressInfo;
    const viewerAddress = viewer.address() as AddressInfo;
    assert.equal(appAddress.family, "IPv4");
    assert.equal(viewerAddress.family, "IPv4");
    assert.equal(appAddress.address, "127.0.0.1");
    assert.equal(viewerAddress.address, "127.0.0.1");
    assert.notEqual(appAddress.port, viewerAddress.port);
    assert.equal(pair.appOrigin, `http://127.0.0.1:${appAddress.port}`);
    assert.equal(pair.viewerOrigin, `http://localhost:${viewerAddress.port}`);
    assert.equal(Object.isFrozen(pair), true);
  } finally {
    await Promise.all([close(app), close(viewer)]);
  }
});

test("pair failure closes every socket it acquired", async () => {
  const app = createServer();
  const viewer = createServer();
  await new Promise<void>((resolve) => app.listen(0, "127.0.0.1", resolve));
  await assert.rejects(
    bindDesktopOriginPair(app, viewer),
    (error) => error instanceof DesktopOriginBindError,
  );
  assert.equal(app.listening, false);
  assert.equal(viewer.listening, false);
});
