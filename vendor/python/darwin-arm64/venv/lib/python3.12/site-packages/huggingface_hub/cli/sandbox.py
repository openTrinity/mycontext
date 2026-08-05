# Copyright 2026 The HuggingFace Team. All rights reserved.
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.
"""Contains commands to run and manage sandboxes on Hugging Face Jobs."""

import sys
import time
from contextlib import contextmanager
from typing import Annotated, Any, Iterator

import click

from huggingface_hub._sandbox import (
    DEFAULT_IDLE_TIMEOUT,
    DEFAULT_IMAGE,
    DEFAULT_SANDBOXES_PER_HOST,
    MODE_LABEL,
    MODE_POOL,
    POOL_LABEL,
    SANDBOX_LABEL,
    SHARED_ID_SEP,
    Sandbox,
    SandboxPool,
    SandboxProcess,
    _split_sandbox_id,
)
from huggingface_hub._sandbox_cache import delete_pool_cache
from huggingface_hub.errors import CLIError, SandboxError

from ._cli_utils import (
    EnvFileOpt,
    EnvOpt,
    SecretsFileOpt,
    SecretsOpt,
    TokenOpt,
    VolumesOpt,
    get_hf_api,
    parse_env_map,
    parse_volumes,
    typer_factory,
)
from ._framework import Argument, Option
from ._output import out
from .jobs import FlavorOpt, NamespaceOpt


sandbox_cli = typer_factory(help="Run and manage sandboxes on Hugging Face Jobs.")
pool_cli = typer_factory(help="Warm pools of host VMs and spawn cheap shared sandboxes from them.")
sandbox_cli.add_group(pool_cli, name="pool")
process_cli = typer_factory(help="List and stop background processes running in a sandbox.")
sandbox_cli.add_group(process_cli, name="process")

SandboxIdArg = Annotated[str, Argument(help="The sandbox id as printed by `hf sandbox create`.")]


@contextmanager
def _connect(sandbox_id: str, *, namespace: str | None, token: str | None) -> Iterator[Sandbox]:
    """Reattach to a sandbox and close the HTTP client when the command is done."""
    sandbox = Sandbox.connect(sandbox_id, namespace=namespace, token=token)
    try:
        yield sandbox
    finally:
        sandbox.close()


@sandbox_cli.command(
    "create",
    examples=[
        "hf sandbox create",
        "hf sandbox create ubuntu:24.04",
        "hf sandbox create --flavor a10g-small",
        "hf sandbox create --pool pool-ab12cd34ef56 --env LOG_LEVEL=debug",
    ],
)
def sandbox_create(
    image: Annotated[str | None, Argument(help="Docker image (needs /bin/sh).")] = None,
    pool: Annotated[
        str | None,
        Option("--pool", help="Spawn a cheap shared sandbox in this pool (from `hf sandbox pool create`)."),
    ] = None,
    flavor: FlavorOpt = None,
    idle_timeout: Annotated[
        str | None,
        Option(help="Auto-terminate the sandbox after this much inactivity (e.g. '10m'). Defaults to 10m."),
    ] = None,
    env: EnvOpt = None,
    secrets: SecretsOpt = None,
    env_file: EnvFileOpt = None,
    secrets_file: SecretsFileOpt = None,
    volume: VolumesOpt = None,
    namespace: NamespaceOpt = None,
    forward_hf_token: Annotated[
        bool, Option("--forward-hf-token", help="Inject your HF token as HF_TOKEN in the sandbox.")
    ] = False,
    token: TokenOpt = None,
) -> None:
    """Create a sandbox: a dedicated VM by default, or a cheap shared one with `--pool`.

    Env and idle-timeout apply to the sandbox in both modes. With `--pool`, the image and
    flavor come from the pool, so passing them here is an error; `--secrets` is also
    rejected since pooled sandboxes have no encrypted-secrets channel (use `--env`). Define
    a pool first with `hf sandbox pool create`.
    """
    start = time.time()
    idle = idle_timeout if idle_timeout is not None else DEFAULT_IDLE_TIMEOUT

    if pool is not None:
        if image is not None or flavor is not None or volume:
            raise CLIError("--pool fixes the image/flavor (and volumes aren't supported); drop those options.")
        if secrets or secrets_file:
            raise CLIError("--pool can't encrypt secrets; pass them with --env/--env-file instead.")
        sbx = SandboxPool.connect(pool, namespace=namespace, token=token).create(
            env=parse_env_map(env, env_file),
            idle_timeout=idle,
            forward_hf_token=forward_hf_token,
        )
        out.result("Sandbox ready", id=sbx.id, host=sbx.host_id, pool=pool, elapsed=f"{time.time() - start:.1f}s")
        out.hint(f"Run a command with `hf sandbox exec {sbx.id} -- echo hello`.")
        out.hint(f"Terminate it with `hf sandbox kill {sbx.id}`.")
        return

    sandbox = Sandbox.create(
        image=image or DEFAULT_IMAGE,
        flavor=flavor or "cpu-basic",
        idle_timeout=idle,
        env=parse_env_map(env, env_file),
        secrets=parse_env_map(secrets, secrets_file),
        volumes=parse_volumes(volume),
        namespace=namespace,
        forward_hf_token=forward_hf_token,
        token=token,
    )
    # Release the HTTP client (the sandbox keeps running)
    sandbox.close()
    out.result("Sandbox ready", id=sandbox.id, image=sandbox.image, elapsed=f"{time.time() - start:.1f}s")
    out.hint(f"Run a command with `hf sandbox exec {sandbox.id} -- echo hello`.")
    out.hint(f"Terminate it with `hf sandbox kill {sandbox.id}`.")


@sandbox_cli.command(
    "exec",
    context_settings={"ignore_unknown_options": True},
    examples=[
        'hf sandbox exec <sandbox_id> -- python -c "print(42)"',
        "hf sandbox exec -w /app <sandbox_id> -- pytest -x",
    ],
)
def sandbox_exec(
    sandbox_id: SandboxIdArg,
    command: Annotated[list[str], Argument(help="The command to run.")],
    workdir: Annotated[str | None, Option("-w", "--workdir", help="Working directory.")] = None,
    env: EnvOpt = None,
    env_file: EnvFileOpt = None,
    exec_timeout: Annotated[
        float | None, Option("--timeout", help="Kill the command after this many seconds.")
    ] = None,
    namespace: NamespaceOpt = None,
    token: TokenOpt = None,
) -> None:
    """Run a command in a sandbox, streaming output. Exits with the command's exit code.

    To start a long-running command in the background instead of waiting for it, use
    `hf sandbox spawn`.
    """

    def write_stdout(data: str) -> None:
        sys.stdout.write(data)
        sys.stdout.flush()

    def write_stderr(data: str) -> None:
        sys.stderr.write(data)
        sys.stderr.flush()

    with _connect(sandbox_id, namespace=namespace, token=token) as sandbox:
        result = sandbox.run(
            list(command),
            env=parse_env_map(env, env_file),
            cwd=workdir,
            timeout=exec_timeout,
            on_stdout=write_stdout,
            on_stderr=write_stderr,
            check=False,
        )
    if result.timed_out:
        out.error(f"Command timed out after {exec_timeout}s.")
        raise click.exceptions.Exit(code=result.exit_code or 124)  # 124: conventional timeout exit code
    if result.exit_code != 0:
        raise click.exceptions.Exit(code=result.exit_code if result.exit_code is not None else 1)


@sandbox_cli.command(
    "spawn",
    context_settings={"ignore_unknown_options": True},
    examples=[
        "hf sandbox spawn <sandbox_id> -- python -m http.server 8000",
        "hf sandbox spawn -w /app <sandbox_id> -- uvicorn app:app",
    ],
)
def sandbox_spawn(
    sandbox_id: SandboxIdArg,
    command: Annotated[list[str], Argument(help="The command to run in the background.")],
    workdir: Annotated[str | None, Option("-w", "--workdir", help="Working directory.")] = None,
    env: EnvOpt = None,
    env_file: EnvFileOpt = None,
    namespace: NamespaceOpt = None,
    token: TokenOpt = None,
) -> None:
    """Start a long-running command in the background and return its pid (don't wait).

    List a sandbox's processes with `hf sandbox process ls` and stop one with
    `hf sandbox process kill`.
    """
    with _connect(sandbox_id, namespace=namespace, token=token) as sandbox:
        process = sandbox.run(list(command), env=parse_env_map(env, env_file), cwd=workdir, background=True)
    out.result("Process started", sandbox=sandbox_id, pid=process.pid)
    out.hint(f"List processes with `hf sandbox process ls {sandbox_id}`.")
    out.hint(f"Stop it with `hf sandbox process kill {sandbox_id} {process.pid}`.")


@sandbox_cli.command(
    "cp",
    examples=[
        "hf sandbox cp data.csv <sandbox_id>:/data/data.csv",
        "hf sandbox cp <sandbox_id>:/app/result.json result.json",
    ],
)
def sandbox_cp(
    src: Annotated[str, Argument(help="Source: a local path or <sandbox_id>:<path>.")],
    dst: Annotated[str, Argument(help="Destination: a local path or <sandbox_id>:<path>.")],
    namespace: NamespaceOpt = None,
    token: TokenOpt = None,
) -> None:
    """Copy a file between the local machine and a sandbox (docker-style)."""

    def parse(ref: str) -> tuple[str | None, str]:
        # Only treat as a sandbox ref when the part before ':' looks like a sandbox id
        # (more than one char): this leaves local paths and Windows drive letters like
        # 'C:\data\file.csv' or 'C:/data/file.csv' (single-letter prefix) untouched.
        if ":" in ref and not ref.startswith((".", "/", "~")):
            sandbox_id, path = ref.split(":", 1)
            if len(sandbox_id) > 1:
                return sandbox_id, path
        return None, ref

    src_sandbox, src_path = parse(src)
    dst_sandbox, dst_path = parse(dst)
    if (src_sandbox is None) == (dst_sandbox is None):
        raise CLIError("Exactly one of SRC and DST must be a sandbox path (<sandbox_id>:<path>).")
    if src_sandbox is not None:
        with _connect(src_sandbox, namespace=namespace, token=token) as sandbox:
            sandbox.files.download(src_path, dst_path)
    else:
        assert dst_sandbox is not None
        with _connect(dst_sandbox, namespace=namespace, token=token) as sandbox:
            sandbox.files.upload(src_path, dst_path)
    out.result("Copied", src=src, dst=dst)


@sandbox_cli.command(
    "kill",
    examples=[
        "hf sandbox kill <sandbox_id>",
        "hf sandbox kill <host_id>   # kills a whole shared host (all its sandboxes)",
        "hf sandbox kill --all",
    ],
)
def sandbox_kill(
    sandbox_id: Annotated[str | None, Argument(help="The sandbox or host id to terminate.")] = None,
    all_: Annotated[bool, Option("--all", help="Terminate every sandbox and host in the namespace.")] = False,
    yes: Annotated[bool, Option("-y", "--yes", help="Answer Yes to prompts automatically.")] = False,
    namespace: NamespaceOpt = None,
    token: TokenOpt = None,
) -> None:
    """Terminate a sandbox, a whole shared host, or everything (--all)."""
    api = get_hf_api(token=token)

    if all_:
        jobs = list(api.list_jobs(status=["RUNNING", "SCHEDULING"], labels={SANDBOX_LABEL: "1"}, namespace=namespace))
        if not jobs:
            out.text("No running sandboxes.")
            return
        out.confirm(f"Terminate {len(jobs)} sandbox job(s) (including shared hosts and all their sandboxes)?", yes=yes)
        for job in jobs:
            api.cancel_job(job_id=job.id, namespace=job.owner.name)
        out.result("Terminated", jobs=len(jobs))
        return

    if sandbox_id is None:
        raise CLIError("Provide a sandbox id, a host id, or --all.")

    sid, ns = _split_sandbox_id(sandbox_id, namespace)
    if SHARED_ID_SEP in sid:
        # One shared sandbox: remove it from its host (frees a slot; host keeps running).
        try:
            with _connect(sandbox_id, namespace=namespace, token=token) as sandbox:
                sandbox.kill()
        except SandboxError as e:
            raise CLIError(str(e)) from e
        out.result("Sandbox terminated", id=sandbox_id)
        return

    # A bare id: either a dedicated sandbox job or a shared host job.
    job = api.inspect_job(job_id=sid, namespace=ns)
    if (job.labels or {}).get(MODE_LABEL) == MODE_POOL:
        out.confirm(f"Terminate shared host {sid} and all of its sandboxes?", yes=yes)
        api.cancel_job(job_id=job.id, namespace=job.owner.name)
        out.result("Host terminated", id=sid)
        return
    try:
        with _connect(sandbox_id, namespace=namespace, token=token) as sandbox:
            sandbox.kill()
    except SandboxError as e:
        raise CLIError(str(e)) from e
    out.result("Sandbox terminated", id=sandbox_id)


@pool_cli.command(
    "create",
    examples=[
        "hf sandbox pool create",
        "hf sandbox pool create python:3.12 --flavor cpu-basic",
        "hf sandbox pool create --per-host 50 --idle-timeout 30m",
    ],
)
def pool_create(
    image: Annotated[str | None, Argument(help="Docker image for the hosts (needs /bin/sh).")] = None,
    flavor: FlavorOpt = None,
    per_host: Annotated[
        int,
        Option("--per-host", min=1, help=f"Sandboxes packed per host VM (default {DEFAULT_SANDBOXES_PER_HOST})."),
    ] = DEFAULT_SANDBOXES_PER_HOST,
    max_hosts: Annotated[
        int | None, Option("--max-hosts", min=1, help="Optional cap on the number of host VMs.")
    ] = None,
    idle_timeout: Annotated[
        str | None,
        Option(help="Shut a host down once it has had no sandboxes for this long (e.g. '10m'). Defaults to 10m."),
    ] = None,
    namespace: NamespaceOpt = None,
    token: TokenOpt = None,
) -> None:
    """Warm a pool: boot one host VM now, tagged so it can be found later by its pool id."""
    start = time.time()
    image = image or DEFAULT_IMAGE
    pool = SandboxPool(
        image=image,
        flavor=flavor or "cpu-basic",
        sandboxes_per_host=per_host,
        max_hosts=max_hosts,
        idle_timeout=idle_timeout if idle_timeout is not None else DEFAULT_IDLE_TIMEOUT,
        namespace=namespace,
        token=token,
    )
    pool_id = pool.name
    host_ids = pool.host_ids
    out.result(
        "Pool created",
        id=pool_id,
        image=image,
        flavor=flavor or "cpu-basic",
        host=host_ids[0],
        elapsed=f"{time.time() - start:.1f}s",
    )
    out.hint(f"Spawn a sandbox with `hf sandbox create --pool {pool_id}`.")
    out.hint(f"Delete the pool (and its hosts) with `hf sandbox pool delete {pool_id}`.")


@pool_cli.command("ls | list", examples=["hf sandbox pool ls"])
def pool_ls(
    namespace: NamespaceOpt = None,
    token: TokenOpt = None,
) -> None:
    """List running sandbox pools (grouped from their host VMs)."""
    api = get_hf_api(token=token)
    pools: dict[str, dict[str, Any]] = {}
    for job in api.list_jobs(status="RUNNING", labels={MODE_LABEL: MODE_POOL}, namespace=namespace):
        pid = (job.labels or {}).get(POOL_LABEL)
        if not pid:
            continue
        env = job.environment if isinstance(job.environment, dict) else {}
        info = pools.setdefault(
            pid,
            {
                "id": pid,
                "image": job.docker_image or job.space_id,
                "flavor": job.flavor,
                "per_host": env.get("SBX_CAPACITY", ""),
                "hosts": 0,
            },
        )
        info["hosts"] += 1
    rows = list(pools.values())
    out.table(rows, id_key="id")
    if not rows:
        out.hint("Create one with `hf sandbox pool create`.")
    else:
        out.hint("Spawn a sandbox with `hf sandbox create --pool <id>`.")


@pool_cli.command(
    "delete | rm",
    examples=["hf sandbox pool delete <pool_id>"],
)
def pool_delete(
    pool_id: Annotated[str, Argument(help="Pool id to delete.")],
    yes: Annotated[bool, Option("-y", "--yes", help="Answer Yes to prompts automatically.")] = False,
    namespace: NamespaceOpt = None,
    token: TokenOpt = None,
) -> None:
    """Terminate every host VM of a pool (and therefore all its sandboxes)."""
    api = get_hf_api(token=token)
    hosts = list(
        api.list_jobs(
            status=["RUNNING", "SCHEDULING"],
            labels={MODE_LABEL: MODE_POOL, POOL_LABEL: pool_id},
            namespace=namespace,
        )
    )
    if not hosts:
        delete_pool_cache(pool_id)
        out.text(f"No running hosts for pool '{pool_id}'.")
        return
    out.confirm(f"Terminate {len(hosts)} host(s) of pool '{pool_id}' (and all their sandboxes)?", yes=yes)
    for job in hosts:
        api.cancel_job(job_id=job.id, namespace=job.owner.name)
    delete_pool_cache(pool_id)
    out.result("Pool deleted", id=pool_id, hosts_terminated=len(hosts))


def _fmt_cmd(cmd: str | list[str]) -> str:
    return cmd if isinstance(cmd, str) else " ".join(cmd)


def _fmt_status(process: SandboxProcess) -> str:
    if process.running:
        return "running"
    return "exited" if process.exit_code is None else f"exited ({process.exit_code})"


@process_cli.command("ls | list", examples=["hf sandbox process ls <sandbox_id>"])
def process_ls(
    sandbox_id: SandboxIdArg,
    namespace: NamespaceOpt = None,
    token: TokenOpt = None,
) -> None:
    """List the background processes running in a sandbox (started with `hf sandbox spawn`)."""
    with _connect(sandbox_id, namespace=namespace, token=token) as sandbox:
        processes = sandbox.processes()
    rows = [{"pid": p.pid, "status": _fmt_status(p), "cmd": _fmt_cmd(p.cmd)} for p in processes]
    out.table(rows, id_key="pid")
    if not rows:
        out.hint(f"Start one with `hf sandbox spawn {sandbox_id} -- <cmd>`.")
    else:
        out.hint(f"Stop one with `hf sandbox process kill {sandbox_id} <pid>`.")


@process_cli.command("kill", examples=["hf sandbox process kill <sandbox_id> <pid>"])
def process_kill(
    sandbox_id: SandboxIdArg,
    pid: Annotated[int, Argument(help="The pid as printed by `hf sandbox process ls`.")],
    namespace: NamespaceOpt = None,
    token: TokenOpt = None,
) -> None:
    """Stop a background process running in a sandbox."""
    with _connect(sandbox_id, namespace=namespace, token=token) as sandbox:
        process = next((p for p in sandbox.processes() if p.pid == pid), None)
        if process is None:
            raise CLIError(f"No process with pid {pid} in sandbox {sandbox_id}.")
        process.kill()
    out.result("Process stopped", sandbox=sandbox_id, pid=pid)
