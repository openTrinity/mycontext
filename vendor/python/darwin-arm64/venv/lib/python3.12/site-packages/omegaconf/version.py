import sys  # pragma: no cover

__version__ = "2.3.1"

msg = """OmegaConf 2.0 and above is compatible with Python 3.6 and newer.
You have the following options:
1. Upgrade to Python 3.6 or newer.
   This is highly recommended. new features will not be added to OmegaConf 1.4.
2. Continue using OmegaConf 1.4:
    You can pip install 'OmegaConf<1.5' to do that.
"""
if sys.version_info < (3, 6):
    raise ImportError(msg)  # pragma: no cover
