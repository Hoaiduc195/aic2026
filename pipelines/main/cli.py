"""Command-line interface for the greenfield pipeline."""

from __future__ import annotations

import argparse
import asyncio
import json
from pathlib import Path

from .config import PipelineConfig
from .core.models import PipelineRequest
from .service import PipelineService


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser("aic-main-pipeline")
    commands = parser.add_subparsers(dest="command", required=True)

    run = commands.add_parser("run", help="process one video or a directory")
    _add_inputs(run)
    run.add_argument("--output-dir", default="outputs")
    run.add_argument("--profile", choices=("local", "modal", "hybrid"), default="local")
    run.add_argument("--config", dest="config_path")
    run.add_argument("--tasks", nargs="+", help="optional task subset")
    run.add_argument("--run-id")

    plan = commands.add_parser("plan", help="validate and print the selected DAG")
    _add_inputs(plan)
    plan.add_argument("--output-dir", default="outputs")
    plan.add_argument("--profile", choices=("local", "modal", "hybrid"), default="local")
    plan.add_argument("--config", dest="config_path")
    plan.add_argument("--tasks", nargs="+")

    for command in ("status", "resume", "retry"):
        item = commands.add_parser(command)
        item.add_argument("--output-dir", default="outputs")
        item.add_argument("--run-id", required=True)
        item.add_argument("--config", dest="config_path")
        if command == "retry":
            item.add_argument("--failed-only", action="store_true")
    return parser


def _add_inputs(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--input", action="append", default=[])
    parser.add_argument("--input-dir", action="append", default=[])
    parser.add_argument("--recursive", action="store_true")


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    if args.command == "status":
        return _status(args)
    if args.command in {"resume", "retry"}:
        return _resume(args)
    inputs = tuple(args.input) + tuple(args.input_dir)
    if not inputs:
        raise SystemExit("one of --input or --input-dir is required")
    config = PipelineConfig.from_toml(args.config_path) if args.config_path else PipelineConfig()
    service = PipelineService(config)
    request = PipelineRequest(
        inputs=inputs,
        output_dir=Path(args.output_dir),
        profile=args.profile,
        config_path=Path(args.config_path) if args.config_path else None,
        run_id=getattr(args, "run_id", None),
        tasks=tuple(args.tasks) if getattr(args, "tasks", None) else None,
        recursive=getattr(args, "recursive", False),
    )
    if args.command == "plan":
        print(json.dumps(_plan(service, request), ensure_ascii=False, indent=2))
        return 0
    result = asyncio.run(service.run(request))
    print(json.dumps({"run_id": result.run_id, "status": result.status.value, "errors": list(result.errors)}, ensure_ascii=False, indent=2))
    return 0 if result.status.value in {"completed", "partial"} else 1


def _plan(service: PipelineService, request: PipelineRequest) -> dict[str, object]:
    config = service._config_for_request(request)
    tasks = request.tasks or config.tasks
    return {
        "profile": config.profile,
        "tasks": [
            {"task": task, "backend": config.node(task).backend, "enabled": config.node(task).enabled}
            for task in tasks
        ],
        "output_dir": str(request.output_dir),
    }


def _status(args: argparse.Namespace) -> int:
    path = Path(args.output_dir) / "runs" / args.run_id / "run.json"
    if not path.exists():
        print(json.dumps({"status": "not_found", "run_id": args.run_id}))
        return 1
    print(path.read_text(encoding="utf-8"))
    return 0


def _resume(args: argparse.Namespace) -> int:
    run_root = Path(args.output_dir) / "runs" / args.run_id
    run_file = run_root / "run.json"
    if not run_file.exists():
        print(json.dumps({"status": "not_found", "run_id": args.run_id}))
        return 1
    record = json.loads(run_file.read_text(encoding="utf-8"))
    inputs = tuple(record.get("inputs", []))
    if not inputs:
        raise SystemExit("run record does not contain resumable inputs")
    config = PipelineConfig.from_toml(args.config_path) if args.config_path else PipelineConfig()
    service = PipelineService(config)
    request = PipelineRequest(
        inputs=inputs,
        output_dir=Path(args.output_dir),
        profile=str(record.get("profile", "local")),
        config_path=Path(args.config_path) if args.config_path else None,
        run_id=args.run_id,
    )
    result = asyncio.run(service.run(request))
    print(json.dumps({"run_id": result.run_id, "status": result.status.value, "errors": list(result.errors)}, ensure_ascii=False, indent=2))
    return 0 if result.status.value in {"completed", "partial"} else 1
