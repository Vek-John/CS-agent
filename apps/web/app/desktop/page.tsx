import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { Cs2dPlaybackHost } from "../../components/playback/cs2d-playback-host";
import { desktopViewerOriginFromHeaders } from "../../lib/desktop/runtime";
import {
  DESKTOP_APP_ORIGIN_HEADER,
  validatedDesktopAppOrigin,
} from "../../lib/desktop/request-origin";

export const dynamic = "force-dynamic";

export default async function DesktopPage() {
  const requestHeaders = await headers();
  const viewerOrigin = desktopViewerOriginFromHeaders(requestHeaders);
  const appOrigin = validatedDesktopAppOrigin(requestHeaders.get(DESKTOP_APP_ORIGIN_HEADER));
  if (!viewerOrigin || !appOrigin) notFound();

  return (
    <Cs2dPlaybackHost
      deployTarget="desktop"
      parentOrigin={appOrigin}
      viewerUrl={`${viewerOrigin}/`}
    />
  );
}
