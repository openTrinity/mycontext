from . import constants


class ResolvedRevision(str):
    """A git revision that has already been resolved to a commit hash.

    `ResolvedRevision` is a `str` subclass, so it can be passed to any `huggingface_hub` method taking a `revision`
    argument. Its string value is the revision initially requested by the user (e.g. `"main"`, `"refs/pr/4"`),
    which keeps URLs and error messages readable, while `.resolved` holds the commit hash it points to.

    Instances are built by [`HfApi.resolve_revision`], which also caches the `revision` -> `commit hash` mapping
    in the local cache (`refs/` folder).

    Attributes:
        initial (`str` or `None`):
            The revision initially requested by the user. If `None`, the string value defaults to `"main"`.
        resolved (`str`):
            The commit hash that `initial` resolves to.

    Example:
    ```python
    >>> from huggingface_hub import resolve_revision
    >>> revision = resolve_revision("openai-community/gpt2")
    >>> revision
    ResolvedRevision(initial=None, resolved='607a30d783dfa663caf39e06633721c8d4cfcd7e')
    >>> revision == "main"  # it's a string
    True
    >>> revision.resolved
    '607a30d783dfa663caf39e06633721c8d4cfcd7e'
    ```
    """

    initial: str | None
    resolved: str

    def __new__(cls, resolved: str, initial: str | None = None) -> "ResolvedRevision":
        revision = super().__new__(cls, initial if initial is not None else constants.DEFAULT_REVISION)
        revision.initial = initial
        revision.resolved = resolved
        return revision

    def __repr__(self) -> str:
        return f"ResolvedRevision(initial={self.initial!r}, resolved={self.resolved!r})"
