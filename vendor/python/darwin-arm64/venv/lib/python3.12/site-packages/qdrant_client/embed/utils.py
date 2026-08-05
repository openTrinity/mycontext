import base64
from pathlib import Path

from pydantic import BaseModel, Field


class FieldPath(BaseModel):
    current: str
    tail: list["FieldPath"] | None = Field(default=None)

    def as_str_list(self) -> list[str]:
        """
        >>> FieldPath(current='a', tail=[FieldPath(current='b', tail=[FieldPath(current='c'), FieldPath(current='d')])]).as_str_list()
        ['a.b.c', 'a.b.d']
        """

        # Recursive function to collect all paths
        def collect_paths(path: FieldPath, prefix: str = "") -> list[str]:
            current_path = prefix + path.current
            if not path.tail:
                return [current_path]
            else:
                paths = []
                for sub_path in path.tail:
                    paths.extend(collect_paths(sub_path, current_path + "."))
                return paths

        # Collect all paths starting from this object
        return collect_paths(self)


def convert_paths(paths: list[str]) -> list[FieldPath]:
    """Convert string paths into FieldPath objects

    Paths which share the same root are grouped together.

    Args:
        paths: List[str]: List of str paths containing "." as separator

    Returns:
        List[FieldPath]: List of FieldPath objects
    """
    sorted_paths = sorted(paths)
    prev_root = None
    converted_paths = []
    for path in sorted_paths:
        parts = path.split(".")
        root = parts[0]
        if root != prev_root:
            converted_paths.append(FieldPath(current=root))
            prev_root = root
        current = converted_paths[-1]
        for part in parts[1:]:
            if current.tail is None:
                current.tail = []
            found = False
            for tail in current.tail:
                if tail.current == part:
                    current = tail
                    found = True
                    break
            if not found:
                new_tail = FieldPath(current=part)
                assert current.tail is not None
                current.tail.append(new_tail)
                current = new_tail
    return converted_paths


def read_base64(file_path: str | Path) -> str:
    """Convert a file path to a base64 encoded string."""
    path = Path(file_path)
    if not path.exists():
        raise FileNotFoundError(f"The file {path} does not exist.")

    with open(path, "rb") as file:
        file_content = file.read()
        return base64.b64encode(file_content).decode("utf-8")
