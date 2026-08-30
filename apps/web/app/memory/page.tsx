import { headers } from "next/headers";
import { MemoryManager } from "../../components/memory/memory-manager";
import { isDesktopRuntimeRequest } from "../../lib/desktop/runtime";

export const dynamic = "force-dynamic";

export default async function MemoryPage() {
  const desktop = isDesktopRuntimeRequest(await headers());
  return (
    <MemoryManager
      backHref={desktop ? "/desktop" : "/"}
      principalNotice={desktop
        ? "当前使用仅保存在本机的桌面主体；记忆、授权和教学偏好都留在此 Mac。"
        : "当前使用匿名浏览器主体；清除本浏览器 Cookie 后，无法恢复或关联到原主体。"}
    />
  );
}
