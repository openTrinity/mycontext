"""Route a KL CLI invocation to one conversation's production server."""

from __future__ import annotations

import argparse
import os

from .servers import route_port

ALLOWED_COMMANDS = frozenset({"search", "ask", "context", "status"})


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument("conversation_id")
    parser.add_argument("command", nargs=argparse.REMAINDER)
    args = parser.parse_args(argv)
    if args.command[:1] == ["--"]:
        args.command = args.command[1:]
    return args


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    command_name = args.command[0] if args.command else ""
    if command_name not in ALLOWED_COMMANDS and command_name not in {"--help", "-h"}:
        raise SystemExit(
            "command disabled in LoCoMo evaluation; allowed: "
            + ", ".join(sorted(ALLOWED_COMMANDS))
        )
    # kl_cli snapshots the port at import time, so route before importing it.
    os.environ["KL_SERVER_PORT"] = str(route_port(args.conversation_id))
    import kl_cli

    try:
        kl_cli.cli.main(args=args.command, prog_name="./kl", standalone_mode=True)
    except SystemExit as exc:
        return int(exc.code or 0)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
