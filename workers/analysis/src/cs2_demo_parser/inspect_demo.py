"""Fast localhost preflight: list Demo identity and players before analysis."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

from .adapter import DemoParserAdapter
from .errors import DemoFileError


MAX_LOCAL_DEMO_BYTES = 512 * 1024 * 1024
CS2_DEMO_MAGIC = b"PBDEMS2\0"
MIN_CS2_DEMO_HEADER_BYTES = 16


def validate_demo_file(path: str | Path, *, max_bytes: int = MAX_LOCAL_DEMO_BYTES) -> Path:
    source = Path(path).expanduser().resolve()
    if source.suffix.lower() != ".dem":
        raise DemoFileError("Demo file must use the .dem extension.", path=str(source))
    if not source.is_file():
        raise DemoFileError("Demo path is not a regular file.", path=str(source))
    size = source.stat().st_size
    if isinstance(max_bytes, bool) or not isinstance(max_bytes, int) or max_bytes <= 0:
        raise DemoFileError("max_bytes must be a positive integer.", path=str(source))
    if size < MIN_CS2_DEMO_HEADER_BYTES or size > max_bytes:
        raise DemoFileError(
            f"Demo size is outside the localhost {MIN_CS2_DEMO_HEADER_BYTES}..{max_bytes} byte boundary.",
            path=str(source),
        )
    with source.open("rb") as handle:
        if handle.read(len(CS2_DEMO_MAGIC)) != CS2_DEMO_MAGIC:
            raise DemoFileError("File does not have the CS2 PBDEMS2 header.", path=str(source))
    return source


def inspect_demo(
    path: str | Path,
    *,
    max_bytes: int = MAX_LOCAL_DEMO_BYTES,
) -> dict[str, object]:
    source = validate_demo_file(path, max_bytes=max_bytes)

    adapter = DemoParserAdapter()
    metadata = adapter.inspect(source)
    players = adapter.read_players(source)
    if not players.players:
        raise DemoFileError("Demo did not expose selectable players.", path=str(source))
    size = source.stat().st_size
    return {
        "source_file_name": source.name,
        "size_bytes": size,
        "map_name": metadata.map_name,
        "parser_version": metadata.parser_version,
        "players": [
            {
                "player_id": player.player_id,
                "display_name": player.display_name or player.player_id,
                "side": player.team.value if player.team is not None else None,
            }
            for player in players.players
        ],
        "warnings": [
            warning.model_dump(mode="json", exclude_none=True)
            for warning in [*metadata.warnings, *players.warnings]
        ],
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Inspect a local CS2 Demo before selecting an analysis player.")
    parser.add_argument("input", type=Path)
    args = parser.parse_args(argv)
    print(json.dumps(inspect_demo(args.input), ensure_ascii=False, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
