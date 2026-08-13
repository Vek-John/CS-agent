from pathlib import Path

import pytest

from cs2_demo_parser.errors import DemoFileError
from cs2_demo_parser.inspect_demo import inspect_demo, validate_demo_file


def test_inspect_demo_rejects_non_demo_extension(tmp_path: Path) -> None:
    source = tmp_path / "payload.bin"
    source.write_bytes(b"PBDEMS2\0data")

    with pytest.raises(DemoFileError, match="extension"):
        inspect_demo(source)


def test_inspect_demo_rejects_invalid_magic(tmp_path: Path) -> None:
    source = tmp_path / "payload.dem"
    source.write_bytes(b"not-a-demo-header")

    with pytest.raises(DemoFileError, match="PBDEMS2"):
        inspect_demo(source)


def test_inspect_demo_rejects_truncated_magic_only_file(tmp_path: Path) -> None:
    source = tmp_path / "truncated.dem"
    source.write_bytes(b"PBDEMS2\0")

    with pytest.raises(DemoFileError, match="size"):
        inspect_demo(source)


def test_validate_demo_file_enforces_regular_file_size_boundary(tmp_path: Path) -> None:
    source = tmp_path / "large.dem"
    source.write_bytes(b"PBDEMS2\0data")

    with pytest.raises(DemoFileError, match="size"):
        validate_demo_file(source, max_bytes=8)
