"""CLI commands for Hugging Face Inference Endpoints."""

import shlex
from typing import Annotated

import click

from huggingface_hub._inference_endpoints import InferenceEndpointScalingMetric, InferenceEndpointType
from huggingface_hub.errors import CLIError, HfHubHTTPError

from ._cli_utils import (
    EnvFileOpt,
    EnvOpt,
    RevisionOpt,
    SecretsFileOpt,
    SecretsOpt,
    SoftChoice,
    TokenOpt,
    get_hf_api,
    parse_env_map,
    typer_factory,
)
from ._framework import Argument, Option
from ._output import out


ie_cli = typer_factory(help="Manage Hugging Face Inference Endpoints.")

catalog_app = typer_factory(help="Interact with the Inference Endpoints catalog.")


NameArg = Annotated[
    str,
    Argument(help="Endpoint name."),
]
NameOpt = Annotated[
    str | None,
    Option(help="Endpoint name."),
]

NamespaceOpt = Annotated[
    str | None,
    Option(
        help="The namespace associated with the Inference Endpoint. Defaults to the current user's namespace.",
    ),
]


@ie_cli.command("list | ls", examples=["hf endpoints ls", "hf endpoints ls --namespace my-org"])
def ls(
    namespace: NamespaceOpt = None,
    token: TokenOpt = None,
) -> None:
    """Lists all Inference Endpoints for the given namespace."""
    api = get_hf_api(token=token)
    try:
        endpoints = api.list_inference_endpoints(namespace=namespace, token=token)
    except HfHubHTTPError as error:
        out.error(f"Listing failed: {error}")
        raise click.exceptions.Exit(code=error.response.status_code) from error

    results = []
    for endpoint in endpoints:
        raw = endpoint.raw
        status = raw.get("status", {})
        model = raw.get("model", {})
        compute = raw.get("compute", {})
        provider = raw.get("provider", {})
        results.append(
            {
                "name": raw.get("name", ""),
                "model": model.get("repository", "") if isinstance(model, dict) else "",
                "status": status.get("state", "") if isinstance(status, dict) else "",
                "task": model.get("task", "") if isinstance(model, dict) else "",
                "framework": model.get("framework", "") if isinstance(model, dict) else "",
                "instance": compute.get("instanceType", "") if isinstance(compute, dict) else "",
                "vendor": provider.get("vendor", "") if isinstance(provider, dict) else "",
                "region": provider.get("region", "") if isinstance(provider, dict) else "",
            }
        )
    out.table(results, id_key="name")


@ie_cli.command(name="deploy", examples=["hf endpoints deploy my-endpoint --repo gpt2 --framework pytorch ..."])
def deploy(
    name: NameArg,
    repo: Annotated[
        str,
        Option(
            help="The name of the model repository associated with the Inference Endpoint (e.g. 'openai/gpt-oss-120b').",
        ),
    ],
    framework: Annotated[
        str,
        Option(
            help="The machine learning framework used for the model (e.g. 'vllm').",
        ),
    ],
    accelerator: Annotated[
        str,
        Option(
            help="The hardware accelerator to be used for inference (e.g. 'cpu').",
        ),
    ],
    instance_size: Annotated[
        str,
        Option(
            help="The size or type of the instance to be used for hosting the model (e.g. 'x4').",
        ),
    ],
    instance_type: Annotated[
        str,
        Option(
            help="The cloud instance type where the Inference Endpoint will be deployed (e.g. 'intel-icl').",
        ),
    ],
    region: Annotated[
        str,
        Option(
            help="The cloud region in which the Inference Endpoint will be created (e.g. 'us-east-1').",
        ),
    ],
    vendor: Annotated[
        str,
        Option(
            help="The cloud provider or vendor where the Inference Endpoint will be hosted (e.g. 'aws').",
        ),
    ],
    *,
    namespace: NamespaceOpt = None,
    task: Annotated[
        str | None,
        Option(
            help="The task on which to deploy the model (e.g. 'text-classification').",
        ),
    ] = None,
    token: TokenOpt = None,
    min_replica: Annotated[
        int,
        Option(
            help="The minimum number of replicas (instances) to keep running for the Inference Endpoint.",
        ),
    ] = 1,
    max_replica: Annotated[
        int,
        Option(
            help="The maximum number of replicas (instances) to scale to for the Inference Endpoint.",
        ),
    ] = 1,
    scale_to_zero_timeout: Annotated[
        int | None,
        Option(
            help="The duration in minutes before an inactive endpoint is scaled to zero.",
        ),
    ] = None,
    scaling_metric: Annotated[
        InferenceEndpointScalingMetric | None,
        Option(
            help="The metric reference for scaling.",
        ),
    ] = None,
    scaling_threshold: Annotated[
        float | None,
        Option(
            help="The scaling metric threshold used to trigger a scale up. Ignored when scaling metric is not provided.",
        ),
    ] = None,
    revision: RevisionOpt = None,
    custom_image: Annotated[
        str | None,
        Option(
            "--custom-image",
            help="Docker image URL for a custom container (e.g. 'nexagi/sglang:v0.5.12'). Requires '--framework custom'.",
        ),
    ] = None,
    health_route: Annotated[
        str | None,
        Option(
            help="Health check route exposed by the custom container (e.g. '/health'). Requires --custom-image.",
        ),
    ] = None,
    port: Annotated[
        int | None,
        Option(
            help="Port the custom container listens on (e.g. 30000). Requires --custom-image.",
        ),
    ] = None,
    container_command: Annotated[
        str | None,
        Option(
            "--container-command",
            help=(
                "Override the container entrypoint, as a quoted string split into tokens "
                '(e.g. "python -m sglang.launch_server"). Requires --custom-image.'
            ),
        ),
    ] = None,
    container_args: Annotated[
        str | None,
        Option(
            "--container-args",
            help=(
                "Arguments appended to the container entrypoint, as a quoted string split into tokens "
                '(e.g. "--tp 8 --reasoning-parser qwen3"). Requires --custom-image.'
            ),
        ),
    ] = None,
    env: EnvOpt = None,
    env_file: EnvFileOpt = None,
    secrets: SecretsOpt = None,
    secrets_file: SecretsFileOpt = None,
    endpoint_type: Annotated[
        str | None,
        Option(
            "--type",
            click_type=SoftChoice(InferenceEndpointType),
            help="Endpoint access type. Defaults to 'authenticated' (token-gated, publicly reachable).",
        ),
    ] = None,
) -> None:
    """Deploy an Inference Endpoint from a Hub repository."""
    # Custom-container knobs only make sense alongside a custom image.
    if custom_image is None and (health_route is not None or port is not None or container_command or container_args):
        raise CLIError("--health-route, --port, --container-command and --container-args require --custom-image.")
    custom_image_dict: dict | None = None
    if custom_image is not None:
        custom_image_dict = {"url": custom_image}
        if health_route is not None:
            custom_image_dict["healthRoute"] = health_route
        if port is not None:
            custom_image_dict["port"] = port

    env_map = {key: value or "" for key, value in parse_env_map(env, env_file).items()}
    secrets_map = {key: value or "" for key, value in parse_env_map(secrets, secrets_file).items()}

    # Only forward the values the user actually set and let `create_inference_endpoint` own the defaults.
    params: dict = {}
    if endpoint_type is not None:
        params["type"] = endpoint_type
    if custom_image_dict is not None:
        params["custom_image"] = custom_image_dict
    if container_command:
        params["container_command"] = shlex.split(container_command)
    if container_args:
        params["container_args"] = shlex.split(container_args)
    if env_map:
        params["env"] = env_map
    if secrets_map:
        params["secrets"] = secrets_map

    api = get_hf_api(token=token)
    endpoint = api.create_inference_endpoint(
        name=name,
        repository=repo,
        framework=framework,
        accelerator=accelerator,
        instance_size=instance_size,
        instance_type=instance_type,
        region=region,
        vendor=vendor,
        namespace=namespace,
        task=task,
        token=token,
        min_replica=min_replica,
        max_replica=max_replica,
        scaling_metric=scaling_metric,
        scaling_threshold=scaling_threshold,
        scale_to_zero_timeout=scale_to_zero_timeout,
        revision=revision,
        **params,
    )
    out.dict(endpoint.raw)
    out.hint(f"Use 'hf endpoints describe {name}' to check the deployment status.")


@catalog_app.command(name="deploy", examples=["hf endpoints catalog deploy --repo meta-llama/Llama-3.2-1B-Instruct"])
def deploy_from_catalog(
    repo: Annotated[
        str,
        Option(
            help="The name of the model repository associated with the Inference Endpoint (e.g. 'openai/gpt-oss-120b').",
        ),
    ],
    name: NameOpt = None,
    accelerator: Annotated[
        str | None,
        Option(
            help="The hardware accelerator to be used for inference (e.g. 'cpu', 'gpu', 'neuron').",
        ),
    ] = None,
    namespace: NamespaceOpt = None,
    token: TokenOpt = None,
) -> None:
    """Deploy an Inference Endpoint from the Model Catalog."""
    api = get_hf_api(token=token)
    try:
        endpoint = api.create_inference_endpoint_from_catalog(
            repo_id=repo,
            name=name,
            accelerator=accelerator,
            namespace=namespace,
            token=token,
        )
    except HfHubHTTPError as error:
        out.error(f"Deployment failed: {error}")
        raise click.exceptions.Exit(code=error.response.status_code) from error

    out.dict(endpoint.raw)


def list_catalog(
    token: TokenOpt = None,
) -> None:
    """List available Catalog models."""
    api = get_hf_api(token=token)
    try:
        models = api.list_inference_catalog(token=token)
    except HfHubHTTPError as error:
        out.error(f"Catalog fetch failed: {error}")
        raise click.exceptions.Exit(code=error.response.status_code) from error

    out.dict({"models": models})


catalog_app.command(name="list | ls", examples=["hf endpoints catalog ls"])(list_catalog)
ie_cli.command(name="list-catalog", hidden=True)(list_catalog)


ie_cli.add_group(catalog_app, name="catalog")


@ie_cli.command(examples=["hf endpoints describe my-endpoint"])
def describe(
    name: NameArg,
    namespace: NamespaceOpt = None,
    token: TokenOpt = None,
) -> None:
    """Get information about an existing endpoint."""
    api = get_hf_api(token=token)
    try:
        endpoint = api.get_inference_endpoint(name=name, namespace=namespace, token=token)
    except HfHubHTTPError as error:
        out.error(f"Fetch failed: {error}")
        raise click.exceptions.Exit(code=error.response.status_code) from error

    out.dict(endpoint.raw)


@ie_cli.command(examples=["hf endpoints update my-endpoint --min-replica 2"])
def update(
    name: NameArg,
    namespace: NamespaceOpt = None,
    repo: Annotated[
        str | None,
        Option(
            help="The name of the model repository associated with the Inference Endpoint (e.g. 'openai/gpt-oss-120b').",
        ),
    ] = None,
    accelerator: Annotated[
        str | None,
        Option(
            help="The hardware accelerator to be used for inference (e.g. 'cpu').",
        ),
    ] = None,
    instance_size: Annotated[
        str | None,
        Option(
            help="The size or type of the instance to be used for hosting the model (e.g. 'x4').",
        ),
    ] = None,
    instance_type: Annotated[
        str | None,
        Option(
            help="The cloud instance type where the Inference Endpoint will be deployed (e.g. 'intel-icl').",
        ),
    ] = None,
    framework: Annotated[
        str | None,
        Option(
            help="The machine learning framework used for the model (e.g. 'custom').",
        ),
    ] = None,
    revision: Annotated[
        str | None,
        Option(
            help="The specific model revision to deploy on the Inference Endpoint (e.g. '6c0e6080953db56375760c0471a8c5f2929baf11').",
        ),
    ] = None,
    task: Annotated[
        str | None,
        Option(
            help="The task on which to deploy the model (e.g. 'text-classification').",
        ),
    ] = None,
    min_replica: Annotated[
        int | None,
        Option(
            help="The minimum number of replicas (instances) to keep running for the Inference Endpoint.",
        ),
    ] = None,
    max_replica: Annotated[
        int | None,
        Option(
            help="The maximum number of replicas (instances) to scale to for the Inference Endpoint.",
        ),
    ] = None,
    scale_to_zero_timeout: Annotated[
        int | None,
        Option(
            help="The duration in minutes before an inactive endpoint is scaled to zero.",
        ),
    ] = None,
    scaling_metric: Annotated[
        InferenceEndpointScalingMetric | None,
        Option(
            help="The metric reference for scaling.",
        ),
    ] = None,
    scaling_threshold: Annotated[
        float | None,
        Option(
            help="The scaling metric threshold used to trigger a scale up. Ignored when scaling metric is not provided.",
        ),
    ] = None,
    token: TokenOpt = None,
) -> None:
    """Update an existing endpoint."""
    api = get_hf_api(token=token)
    try:
        endpoint = api.update_inference_endpoint(
            name=name,
            namespace=namespace,
            repository=repo,
            framework=framework,
            revision=revision,
            task=task,
            accelerator=accelerator,
            instance_size=instance_size,
            instance_type=instance_type,
            min_replica=min_replica,
            max_replica=max_replica,
            scale_to_zero_timeout=scale_to_zero_timeout,
            scaling_metric=scaling_metric,
            scaling_threshold=scaling_threshold,
            token=token,
        )
    except HfHubHTTPError as error:
        out.error(f"Update failed: {error}")
        raise click.exceptions.Exit(code=error.response.status_code) from error
    out.dict(endpoint.raw)


@ie_cli.command(examples=["hf endpoints delete my-endpoint"])
def delete(
    name: NameArg,
    namespace: NamespaceOpt = None,
    yes: Annotated[
        bool,
        Option("--yes", help="Skip confirmation prompts."),
    ] = False,
    token: TokenOpt = None,
) -> None:
    """Delete an Inference Endpoint permanently."""
    out.confirm(f"Delete endpoint '{name}'?", yes=yes)

    api = get_hf_api(token=token)
    try:
        api.delete_inference_endpoint(name=name, namespace=namespace, token=token)
    except HfHubHTTPError as error:
        out.error(f"Delete failed: {error}")
        raise click.exceptions.Exit(code=error.response.status_code) from error

    out.result(f"Deleted '{name}'.", name=name)


@ie_cli.command(examples=["hf endpoints pause my-endpoint"])
def pause(
    name: NameArg,
    namespace: NamespaceOpt = None,
    token: TokenOpt = None,
) -> None:
    """Pause an Inference Endpoint."""
    api = get_hf_api(token=token)
    try:
        endpoint = api.pause_inference_endpoint(name=name, namespace=namespace, token=token)
    except HfHubHTTPError as error:
        out.error(f"Pause failed: {error}")
        raise click.exceptions.Exit(code=error.response.status_code) from error

    out.dict(endpoint.raw)


@ie_cli.command(examples=["hf endpoints resume my-endpoint"])
def resume(
    name: NameArg,
    namespace: NamespaceOpt = None,
    fail_if_already_running: Annotated[
        bool,
        Option(
            "--fail-if-already-running",
            help="If `True`, the method will raise an error if the Inference Endpoint is already running.",
        ),
    ] = False,
    token: TokenOpt = None,
) -> None:
    """Resume an Inference Endpoint."""
    api = get_hf_api(token=token)
    try:
        endpoint = api.resume_inference_endpoint(
            name=name,
            namespace=namespace,
            token=token,
            running_ok=not fail_if_already_running,
        )
    except HfHubHTTPError as error:
        out.error(f"Resume failed: {error}")
        raise click.exceptions.Exit(code=error.response.status_code) from error
    out.dict(endpoint.raw)


@ie_cli.command(examples=["hf endpoints scale-to-zero my-endpoint"])
def scale_to_zero(
    name: NameArg,
    namespace: NamespaceOpt = None,
    token: TokenOpt = None,
) -> None:
    """Scale an Inference Endpoint to zero."""
    api = get_hf_api(token=token)
    try:
        endpoint = api.scale_to_zero_inference_endpoint(name=name, namespace=namespace, token=token)
    except HfHubHTTPError as error:
        out.error(f"Scale To Zero failed: {error}")
        raise click.exceptions.Exit(code=error.response.status_code) from error

    out.dict(endpoint.raw)
