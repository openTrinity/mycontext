import warnings

SEEN_MESSAGES = set()


def show_warning(message: str, category: type[Warning] = UserWarning, stacklevel: int = 2) -> None:
    warnings.warn(message, category, stacklevel=stacklevel)


def show_warning_once(
    message: str,
    category: type[Warning] = UserWarning,
    idx: str | None = None,
    stacklevel: int = 1,
) -> None:
    """
    Show a warning of the specified category only once per program run.
    """
    key = idx if idx is not None else message

    if key not in SEEN_MESSAGES:
        SEEN_MESSAGES.add(key)
        show_warning(message, category, stacklevel)
