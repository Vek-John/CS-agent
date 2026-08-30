import { Cs2dPlaybackHost } from "../components/playback/cs2d-playback-host";

export default function Home() {
  return (
    <>
      <a className="memory-home-entry" href="/memory">长期记忆</a>
      <Cs2dPlaybackHost />
    </>
  );
}
