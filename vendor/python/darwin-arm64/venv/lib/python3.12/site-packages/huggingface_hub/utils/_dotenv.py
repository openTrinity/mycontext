# AI-generated module (ChatGPT)
import re


# Escape sequences expanded inside quoted values. Double-quoted values additionally
# expand "\$" to "$"; single-quoted values keep it verbatim.
_ESCAPES = {"n": "\n", "t": "\t", '"': '"', "\\": "\\"}
_DOUBLE_QUOTE_ESCAPES = {**_ESCAPES, "$": "$"}


def _unescape(value: str, escapes: dict[str, str]) -> str:
    r"""Expand backslash escapes in a single left-to-right pass.

    Processing in one pass (rather than chained `str.replace` calls) ensures an escaped
    backslash (`\\`) is consumed as a unit and cannot merge with the following character,
    e.g. `\\n` is a backslash followed by `n`, not a newline. Unknown escapes are kept as-is.
    """
    return re.sub(r"\\(.)", lambda match: escapes.get(match.group(1), match.group(0)), value)


def load_dotenv(dotenv_str: str, environ: dict[str, str] | None = None) -> dict[str, str]:
    """
    Parse a DOTENV-format string and return a dictionary of key-value pairs.
    Handles quoted values, comments, export keyword, and blank lines.
    """
    env: dict[str, str] = {}
    line_pattern = re.compile(
        r"""
        ^\s*
        (?:export[^\S\n]+)?               # optional export
        ([A-Za-z_][A-Za-z0-9_]*)          # key
        [^\S\n]*(=)?[^\S\n]*
        (                                 # value group
            (?:
                '(?:\\'|[^'])*'           # single-quoted value
                | \"(?:\\\"|[^\"])*\"     # double-quoted value
                | [^#\n\r]+?              # unquoted value
            )
        )?
        [^\S\n]*(?:\#.*)?$                # optional inline comment
    """,
        re.VERBOSE,
    )

    for line in dotenv_str.splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue  # Skip comments and empty lines

        match = line_pattern.match(line)
        if match:
            key = match.group(1)
            val = None
            if match.group(2):  # if there is '='
                raw_val = match.group(3) or ""
                val = raw_val.strip()
                # Remove surrounding quotes if quoted
                if (val.startswith('"') and val.endswith('"')) or (val.startswith("'") and val.endswith("'")):
                    escapes = _DOUBLE_QUOTE_ESCAPES if raw_val.startswith('"') else _ESCAPES
                    val = _unescape(val[1:-1], escapes)
            elif environ is not None:
                # Get it from the current environment
                val = environ.get(key)

            if val is not None:
                env[key] = val

    return env
