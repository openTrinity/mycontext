# pyright: reportUnknownMemberType=false, reportAttributeAccessIssue=false
"""Module portalocker.

This module provides cross-platform file locking functionality.
The Windows implementation now supports two variants:

  1. A default method using the Win32 API (win32file.LockFileEx/UnlockFileEx).
  2. An alternative that uses msvcrt.locking for exclusive locks (shared
     locks still use the Win32 API).

This version uses classes to encapsulate locking logic, while maintaining
the original external API, including the LOCKER constant for specific
backwards compatibility (POSIX) and Windows behavior.
"""

import io
import os
import typing
from typing import (
    Any,
    Callable,
    Optional,
    Union,
    cast,
)

from . import constants, exceptions, types

# Alias for readability
LockFlags = constants.LockFlags


# Define a protocol for callable lockers
class LockCallable(typing.Protocol):
    def __call__(
        self, file_obj: types.FileArgument, flags: LockFlags
    ) -> None: ...


class UnlockCallable(typing.Protocol):
    def __call__(self, file_obj: types.FileArgument) -> None: ...


class BaseLocker:
    """Base class for locker implementations."""

    def lock(self, file_obj: types.FileArgument, flags: LockFlags) -> None:
        """Lock the file."""
        raise NotImplementedError

    def unlock(self, file_obj: types.FileArgument) -> None:
        """Unlock the file."""
        raise NotImplementedError


# Define refined LockerType with more specific types
LockerType = Union[
    # POSIX-style fcntl.flock callable
    Callable[[Union[int, types.HasFileno], int], Any],
    # Tuple of lock and unlock functions
    tuple[LockCallable, UnlockCallable],
    # BaseLocker instance
    BaseLocker,
    # BaseLocker class
    type[BaseLocker],
]

LOCKER: LockerType

if os.name == 'nt':  # pragma: not-posix
    # Windows-specific helper functions
    def _prepare_windows_file(
        file_obj: types.FileArgument,
    ) -> tuple[int, Optional[typing.IO[Any]], Optional[int]]:
        """Prepare file for Windows: get fd, optionally seek and save pos."""
        if isinstance(file_obj, int):
            # Plain file descriptor
            return file_obj, None, None

        # Full IO objects (have tell/seek) -> preserve and restore position
        if isinstance(file_obj, io.IOBase):
            fd: int = file_obj.fileno()
            original_pos = file_obj.tell()
            if original_pos != 0:
                file_obj.seek(0)
            return fd, typing.cast(typing.IO[Any], file_obj), original_pos
            # cast satisfies mypy: IOBase -> IO[Any]

        # Fallback: an object that only implements fileno() (HasFileno)
        fd = typing.cast(types.HasFileno, file_obj).fileno()  # type: ignore[redundant-cast]
        return fd, None, None

    def _restore_windows_file_pos(
        file_io_obj: Optional[typing.IO[Any]],
        original_pos: Optional[int],
    ) -> None:
        """Restore file position if it was an IO object and pos was saved."""
        if file_io_obj and original_pos is not None and original_pos != 0:
            file_io_obj.seek(original_pos)

    class Win32Locker(BaseLocker):
        """Locker using Win32 API (LockFileEx/UnlockFileEx)."""

        _overlapped: Any  # pywintypes.OVERLAPPED
        _lock_bytes_low: int = -0x10000

        def __init__(self) -> None:
            try:
                import pywintypes
            except ImportError as e:
                raise ImportError(
                    'pywintypes is required for Win32Locker but not '
                    'found. Please install pywin32.'
                ) from e
            self._overlapped = pywintypes.OVERLAPPED()

        def _get_os_handle(self, fd: int) -> int:
            try:
                import msvcrt
            except ImportError as e:
                raise ImportError(
                    'msvcrt is required for _get_os_handle on Windows '
                    'but not found.'
                ) from e
            return cast(int, msvcrt.get_osfhandle(fd))  # type: ignore[attr-defined,redundant-cast]

        def lock(self, file_obj: types.FileArgument, flags: LockFlags) -> None:
            import pywintypes
            import win32con
            import win32file
            import winerror

            fd, io_obj_ctx, pos_ctx = _prepare_windows_file(file_obj)
            os_fh = self._get_os_handle(fd)

            mode = 0
            if flags & LockFlags.NON_BLOCKING:
                mode |= win32con.LOCKFILE_FAIL_IMMEDIATELY
            if flags & LockFlags.EXCLUSIVE:
                mode |= win32con.LOCKFILE_EXCLUSIVE_LOCK

            try:
                win32file.LockFileEx(
                    os_fh, mode, 0, self._lock_bytes_low, self._overlapped
                )
            except pywintypes.error as exc_value:  # type: ignore[misc]
                if exc_value.winerror == winerror.ERROR_LOCK_VIOLATION:
                    raise exceptions.AlreadyLocked(
                        exceptions.LockException.LOCK_FAILED,
                        exc_value.strerror,
                        fh=file_obj,  # Pass original file_obj
                    ) from exc_value
                else:
                    raise
            finally:
                _restore_windows_file_pos(io_obj_ctx, pos_ctx)

        def unlock(self, file_obj: types.FileArgument) -> None:
            import pywintypes
            import win32file
            import winerror

            fd, io_obj_ctx, pos_ctx = _prepare_windows_file(file_obj)
            os_fh = self._get_os_handle(fd)

            try:
                win32file.UnlockFileEx(
                    os_fh, 0, self._lock_bytes_low, self._overlapped
                )
            except pywintypes.error as exc:  # type: ignore[misc]
                if exc.winerror != winerror.ERROR_NOT_LOCKED:
                    raise exceptions.LockException(
                        exceptions.LockException.LOCK_FAILED,
                        exc.strerror,
                        fh=file_obj,  # Pass original file_obj
                    ) from exc
            except OSError as exc:
                raise exceptions.LockException(
                    exceptions.LockException.LOCK_FAILED,
                    exc.strerror,
                    fh=file_obj,  # Pass original file_obj
                ) from exc
            finally:
                _restore_windows_file_pos(io_obj_ctx, pos_ctx)

    class MsvcrtLocker(BaseLocker):
        _win32_locker: Win32Locker
        _msvcrt_lock_length: int = 0x10000

        def __init__(self) -> None:
            self._win32_locker = Win32Locker()
            try:
                import msvcrt
            except ImportError as e:
                raise ImportError(
                    'msvcrt is required for MsvcrtLocker but not found.'
                ) from e

            attrs = ['LK_LOCK', 'LK_RLCK', 'LK_NBLCK', 'LK_UNLCK', 'LK_NBRLCK']
            defaults = [0, 1, 2, 3, 2]  # LK_NBRLCK often same as LK_NBLCK (2)
            for attr, default_val in zip(attrs, defaults):
                if not hasattr(msvcrt, attr):
                    setattr(msvcrt, attr, default_val)

        def lock(self, file_obj: types.FileArgument, flags: LockFlags) -> None:
            import msvcrt

            if flags & LockFlags.SHARED:
                win32_api_flags = LockFlags(0)
                if flags & LockFlags.NON_BLOCKING:
                    win32_api_flags |= LockFlags.NON_BLOCKING
                self._win32_locker.lock(file_obj, win32_api_flags)
                return

            fd, io_obj_ctx, pos_ctx = _prepare_windows_file(file_obj)
            mode = (
                msvcrt.LK_NBLCK  # type: ignore[attr-defined]
                if flags & LockFlags.NON_BLOCKING
                else msvcrt.LK_LOCK  # type: ignore[attr-defined]
            )

            try:
                msvcrt.locking(  # type: ignore[attr-defined]
                    fd,
                    mode,
                    self._msvcrt_lock_length,
                )
            except OSError as exc_value:
                if exc_value.errno in (13, 16, 33, 36):
                    raise exceptions.AlreadyLocked(
                        exceptions.LockException.LOCK_FAILED,
                        str(exc_value),
                        fh=file_obj,  # Pass original file_obj
                    ) from exc_value
                raise exceptions.LockException(
                    exceptions.LockException.LOCK_FAILED,
                    str(exc_value),
                    fh=file_obj,  # Pass original file_obj
                ) from exc_value
            finally:
                _restore_windows_file_pos(io_obj_ctx, pos_ctx)

        def unlock(self, file_obj: types.FileArgument) -> None:
            import msvcrt

            fd, io_obj_ctx, pos_ctx = _prepare_windows_file(file_obj)
            took_fallback_path = False

            try:
                msvcrt.locking(  # type: ignore[attr-defined]
                    fd,
                    msvcrt.LK_UNLCK,  # type: ignore[attr-defined]
                    self._msvcrt_lock_length,
                )
            except OSError as exc:
                if exc.errno == 13:  # EACCES (Permission denied)
                    took_fallback_path = True
                    # Restore position before calling win32_locker,
                    # as it will re-prepare.
                    _restore_windows_file_pos(io_obj_ctx, pos_ctx)
                    try:
                        self._win32_locker.unlock(
                            file_obj
                        )  # win32_locker handles its own seeking
                    except exceptions.LockException as win32_exc:
                        raise exceptions.LockException(
                            exceptions.LockException.LOCK_FAILED,
                            f'msvcrt unlock failed ({exc.strerror}), and '
                            f'win32 fallback failed ({win32_exc.strerror})',
                            fh=file_obj,
                        ) from win32_exc
                    except Exception as final_exc:
                        raise exceptions.LockException(
                            exceptions.LockException.LOCK_FAILED,
                            f'msvcrt unlock failed ({exc.strerror}), and '
                            f'win32 fallback failed with unexpected error: '
                            f'{final_exc!s}',
                            fh=file_obj,
                        ) from final_exc
                else:
                    raise exceptions.LockException(
                        exceptions.LockException.LOCK_FAILED,
                        exc.strerror,
                        fh=file_obj,
                    ) from exc
            finally:
                if not took_fallback_path:
                    _restore_windows_file_pos(io_obj_ctx, pos_ctx)

    _locker_instances: dict[type[BaseLocker], BaseLocker] = dict()

    LOCKER = MsvcrtLocker  # type: ignore[reportConstantRedefinition]

    def lock(file: types.FileArgument, flags: LockFlags) -> None:
        if isinstance(LOCKER, BaseLocker):
            # If LOCKER is a BaseLocker instance, use its lock method
            locker: Callable[[types.FileArgument, LockFlags], None] = (
                LOCKER.lock
            )
        elif isinstance(LOCKER, tuple):
            locker = LOCKER[0]  # type: ignore[reportUnknownVariableType]
        elif issubclass(LOCKER, BaseLocker):  # type: ignore[unreachable,arg-type]  # pyright: ignore [reportUnnecessaryIsInstance]
            locker_instance = _locker_instances.get(LOCKER)  # type: ignore[arg-type]
            if locker_instance is None:
                # Create an instance of the locker class if not already done
                _locker_instances[LOCKER] = locker_instance = LOCKER()  # type: ignore[ignore,index,call-arg]

            locker = locker_instance.lock
        else:
            raise TypeError(
                f'LOCKER must be a BaseLocker instance, a tuple of lock and '
                f'unlock functions, or a subclass of BaseLocker, '
                f'got {type(LOCKER)}.'
            )

        locker(file, flags)

    def unlock(file: types.FileArgument) -> None:
        if isinstance(LOCKER, BaseLocker):
            # If LOCKER is a BaseLocker instance, use its lock method
            unlocker: Callable[[types.FileArgument], None] = LOCKER.unlock
        elif isinstance(LOCKER, tuple):
            unlocker = LOCKER[1]  # type: ignore[reportUnknownVariableType]

        elif issubclass(LOCKER, BaseLocker):  # type: ignore[unreachable,arg-type]  # pyright: ignore [reportUnnecessaryIsInstance]
            locker_instance = _locker_instances.get(LOCKER)  # type: ignore[arg-type]
            if locker_instance is None:
                # Create an instance of the locker class if not already done
                _locker_instances[LOCKER] = locker_instance = LOCKER()  # type: ignore[ignore,index,call-arg]

            unlocker = locker_instance.unlock
        else:
            raise TypeError(
                f'LOCKER must be a BaseLocker instance, a tuple of lock and '
                f'unlock functions, or a subclass of BaseLocker, '
                f'got {type(LOCKER)}.'
            )

        unlocker(file)

else:  # pragma: not-nt
    import errno
    import fcntl

    # PosixLocker methods accept FileArgument | HasFileno
    PosixFileArgument = Union[types.FileArgument, types.HasFileno]

    class PosixLocker(BaseLocker):
        """Locker implementation using the `LOCKER` constant"""

        _locker: Optional[
            Callable[[Union[int, types.HasFileno], int], Any]
        ] = None

        @property
        def locker(self) -> Callable[[Union[int, types.HasFileno], int], Any]:
            if self._locker is None:
                # On POSIX systems ``LOCKER`` is a callable (fcntl.flock) but
                # mypy also sees the Windows-only tuple assignment.  Explicitly
                # cast so mypy knows we are returning the callable variant
                # here.
                return cast(
                    Callable[[Union[int, types.HasFileno], int], Any], LOCKER
                )  # pyright: ignore[reportUnnecessaryCast]

            # mypy does not realise ``self._locker`` is non-None after the
            # check
            assert self._locker is not None
            return self._locker

        def _get_fd(self, file_obj: PosixFileArgument) -> int:
            if isinstance(file_obj, int):
                return file_obj
            # Check for fileno() method; covers typing.IO and HasFileno
            elif hasattr(file_obj, 'fileno') and callable(file_obj.fileno):
                return file_obj.fileno()
            else:
                # Should not be reached if PosixFileArgument is correct.
                # isinstance(file_obj, io.IOBase) could be an
                # alternative check
                # but hasattr is more general for HasFileno.
                raise TypeError(
                    "Argument 'file_obj' must be an int, an IO object "
                    'with fileno(), or implement HasFileno.'
                )

        def lock(self, file_obj: PosixFileArgument, flags: LockFlags) -> None:
            if (flags & LockFlags.NON_BLOCKING) and not flags & (
                LockFlags.SHARED | LockFlags.EXCLUSIVE
            ):
                raise RuntimeError(
                    'When locking in non-blocking mode on POSIX, '
                    'the SHARED or EXCLUSIVE flag must be specified as well.'
                )

            fd = self._get_fd(file_obj)
            try:
                self.locker(fd, flags)
            except OSError as exc_value:
                if exc_value.errno in (errno.EACCES, errno.EAGAIN):
                    raise exceptions.AlreadyLocked(
                        exc_value,
                        strerror=str(exc_value),
                        fh=file_obj,  # Pass original file_obj
                    ) from exc_value
                else:
                    raise exceptions.LockException(
                        exc_value,
                        strerror=str(exc_value),
                        fh=file_obj,  # Pass original file_obj
                    ) from exc_value
            except EOFError as exc_value:  # NFS specific
                raise exceptions.LockException(
                    exc_value,
                    strerror=str(exc_value),
                    fh=file_obj,  # Pass original file_obj
                ) from exc_value

        def unlock(self, file_obj: PosixFileArgument) -> None:
            fd = self._get_fd(file_obj)
            self.locker(fd, LockFlags.UNBLOCK)

    class FlockLocker(PosixLocker):
        """FlockLocker is a PosixLocker implementation using fcntl.flock."""

        LOCKER = fcntl.flock  # type: ignore[attr-defined]

    class LockfLocker(PosixLocker):
        """LockfLocker is a PosixLocker implementation using fcntl.lockf."""

        LOCKER = fcntl.lockf  # type: ignore[attr-defined]

    # LOCKER constant for POSIX is fcntl.flock for backward compatibility.
    # Type matches: Callable[[Union[int, HasFileno], int], Any]
    LOCKER = fcntl.flock  # type: ignore[attr-defined,reportConstantRedefinition]

    _posix_locker_instance = PosixLocker()

    # Public API for POSIX uses the PosixLocker instance
    def lock(file: types.FileArgument, flags: LockFlags) -> None:
        _posix_locker_instance.lock(file, flags)

    def unlock(file: types.FileArgument) -> None:
        _posix_locker_instance.unlock(file)
