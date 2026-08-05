from collections import OrderedDict
from typing import Any

from . import is_google_colab, is_notebook
from .tqdm import _create_progress_bar, tqdm


def _format_speed_postfix(speed: float | None) -> str:
    s = tqdm.format_sizeof(speed) if speed is not None else "???"
    return f"{s}B/s  ".rjust(10, " ")


# Transfer byte count is hard to predict (dedup/compression), so we omit a total and show bytes only.
XET_TRANSFER_BAR_FORMAT = "{desc}: {bar}| {n_fmt:>5}B{postfix:>12}"
XET_BYTES_BAR_FORMAT = "{l_bar}{bar}| {n_fmt:>5}B / {total_fmt:>5}B{postfix:>12}"


def _set_monotonic_total(bar, total: int | None) -> None:
    if total is None or not hasattr(bar, "total"):
        return
    bar.total = max(bar.total or 0, total)


def _update_transfer_bar(bar, inc: int) -> None:
    """Update the transfer bar and grow its hidden total so the bar graphic advances.

    Network bytes are hard to predict (dedup/compression), so the display omits a denominator.
    tqdm still needs an internal total for the bar width — seeded from file size when known,
    then expanded here if bytes received exceed that estimate.
    """
    n_after = getattr(bar, "n", 0) + inc
    current_total = getattr(bar, "total", 0) or 0
    if n_after > 0 and current_total < n_after:
        bar.total = max(current_total, int(n_after * 1.25) + 1)
    bar.update(inc)


def _finish_transfer_bar(bar) -> None:
    """Snap the transfer bar to 100% when downloading stops.

    Transfer totals are seeded from file size, but actual network bytes are often lower.
    Set ``total = n`` so the bar fills completely instead of stopping partway.
    """
    n = getattr(bar, "n", 0)
    if n > 0 and hasattr(bar, "total") and bar.total != n:
        bar.total = n
        bar.refresh()


def _set_aggregate_rate_postfix(bar) -> None:
    """Show a shared bar's own throughput as its rate.

    When many files feed one bar (snapshot download), each file only knows its own per-item rate — a
    fraction of the total. Deriving the rate from the shared bar's aggregated byte count reports the
    true combined speed instead of whichever single file reported last.
    """
    bar.set_postfix_str(_format_speed_postfix(bar.format_dict.get("rate")), refresh=False)


class XetDownloadProgressReporter:
    """Dual progress bars for Xet downloads: network transfer and file reconstruction.

    ``total_transfer_bytes_completed`` tracks bytes received from the network (updated continuously).
    ``total_bytes_completed`` tracks bytes written to disk (updated after buffered chunks are flushed).
    Showing both bars gives responsive feedback on slow connections where reconstruction lags behind transfer.
    """

    def __init__(
        self,
        *,
        reconstruction_desc: str,
        transfer_desc: str = "Downloading bytes",
        total: int | None = None,
        log_level: int,
        name: str | None = None,
        tqdm_class: type | None = None,
        external_reconstruction_bar: Any | None = None,
        position: int = 0,
    ):
        self._prev_bytes_completed = 0
        self._prev_transfer_bytes_completed = 0

        cls = tqdm_class or tqdm
        routes_transfer_via_reconstruction = external_reconstruction_bar is not None and callable(
            getattr(external_reconstruction_bar, "update_transfer", None)
        )
        uses_aggregated_tqdm_class = external_reconstruction_bar is None and callable(
            getattr(cls, "update_transfer", None)
        )

        if external_reconstruction_bar is not None:
            self.reconstruction_bar = external_reconstruction_bar
            self._owns_reconstruction_bar = False
        else:
            self.reconstruction_bar = _create_progress_bar(
                cls=cls,  # ty: ignore[invalid-argument-type]
                log_level=log_level,
                name=name,
                desc=reconstruction_desc,
                total=total,
                unit="B",
                unit_scale=True,
                position=position + 1,
                bar_format=XET_BYTES_BAR_FORMAT,
                leave=True,
            )
            self._owns_reconstruction_bar = True

        if routes_transfer_via_reconstruction or uses_aggregated_tqdm_class:
            self.transfer_bar = self.reconstruction_bar
            self._owns_transfer_bar = False
        elif external_reconstruction_bar is not None:
            self.transfer_bar = None
            self._owns_transfer_bar = False
        else:
            self.transfer_bar = _create_progress_bar(
                cls=tqdm,
                log_level=log_level,
                name=f"{name}.transfer" if name else None,
                desc=transfer_desc,
                total=total,
                unit="B",
                unit_scale=True,
                position=position,
                bar_format=XET_TRANSFER_BAR_FORMAT,
                leave=True,
            )
            self._owns_transfer_bar = True

    @property
    def _aggregated(self) -> bool:
        return self.transfer_bar is not None and self.transfer_bar is self.reconstruction_bar

    def update_progress(self, group_report, _item_reports: dict | None = None) -> None:
        bytes_inc = max(0, group_report.total_bytes_completed - self._prev_bytes_completed)
        transfer_inc = max(0, group_report.total_transfer_bytes_completed - self._prev_transfer_bytes_completed)
        self._prev_bytes_completed = group_report.total_bytes_completed
        self._prev_transfer_bytes_completed = group_report.total_transfer_bytes_completed

        if bytes_inc > 0:
            self.reconstruction_bar.update(bytes_inc)
            self.reconstruction_bar.set_postfix_str(
                _format_speed_postfix(group_report.total_bytes_completion_rate), refresh=False
            )

        if transfer_inc > 0 and self.transfer_bar is not None:
            if self._aggregated:
                self.reconstruction_bar.update_transfer(transfer_inc)
                self.reconstruction_bar.set_transfer_postfix_str(
                    _format_speed_postfix(group_report.total_transfer_bytes_completion_rate), refresh=False
                )
            else:
                _update_transfer_bar(self.transfer_bar, transfer_inc)
                self.transfer_bar.set_postfix_str(
                    _format_speed_postfix(group_report.total_transfer_bytes_completion_rate), refresh=False
                )

        if group_report.total_bytes:
            _set_monotonic_total(self.reconstruction_bar, group_report.total_bytes)

    def close(self) -> None:
        """Close bars owned by this reporter.

        Standalone downloads finish the transfer bar first (snap hidden total to ``n``), then close it.
        Aggregated and external bars (e.g. snapshot ``_AggregatedTqdm`` or a reused ``_tqdm_bar``) are left
        open — their parent caller owns their lifecycle.
        """
        if self.transfer_bar is not None and self._owns_transfer_bar:
            _finish_transfer_bar(self.transfer_bar)
            if hasattr(self.transfer_bar, "close"):
                self.transfer_bar.close()
        if self._owns_reconstruction_bar and hasattr(self.reconstruction_bar, "close"):
            self.reconstruction_bar.close()

    def __enter__(self) -> "XetDownloadProgressReporter":
        return self

    def __exit__(self, *args) -> None:
        self.close()


class XetUploadProgressReporter:
    """
    Reports on progress for Xet uploads.

    Shows summary progress bars when running in notebooks or GUIs, and detailed per-file progress in console environments.
    """

    def __init__(self, n_lines: int = 10, description_width: int = 30, total_files: int | None = None):
        self.n_lines = n_lines
        self.description_width = description_width
        self.total_files = total_files

        self.per_file_progress = is_google_colab() or not is_notebook()

        self.tqdm_settings = {
            "unit": "B",
            "unit_scale": True,
            "leave": True,
            "unit_divisor": 1000,
            "nrows": n_lines + 3 if self.per_file_progress else 3,
            "miniters": 1,
            "bar_format": XET_BYTES_BAR_FORMAT,
        }

        # Overall progress bars
        self.data_processing_bar = tqdm(
            total=0, desc=self.format_desc("Processing Files (0 / 0)", False), position=0, **self.tqdm_settings
        )

        self.upload_bar = tqdm(
            total=0, desc=self.format_desc("New Data Upload", False), position=1, **self.tqdm_settings
        )

        self.known_items: set[str] = set()
        self.completed_items: set[str] = set()

        # Track previous absolute values to compute increments
        self._prev_bytes_completed: int = 0
        self._prev_transfer_bytes_completed: int = 0

        # Item bars (scrolling view)
        self.item_state: OrderedDict[str, Any] = OrderedDict()
        self.current_bars: list = [None] * self.n_lines

    def format_desc(self, name: str, indent: bool) -> str:
        """
        if name is longer than width characters, prints ... at the start and then the last width-3 characters of the name, otherwise
        the whole name right justified into description_width characters.  Also adds some padding.
        """

        if not self.per_file_progress:
            # Here we just use the defaults.
            return name

        padding = "  " if indent else ""
        width = self.description_width - len(padding)

        if len(name) > width:
            name = f"...{name[-(width - 3) :]}"

        return f"{padding}{name.ljust(width)}"

    def reset_for_next_commit(self):
        """Reset per-commit state so the reporter can be reused across multiple upload commits."""
        self._prev_bytes_completed = 0
        self._prev_transfer_bytes_completed = 0
        self.known_items.clear()
        self.completed_items.clear()
        self.item_state.clear()

    def update_progress(self, group_report, item_reports: dict):
        # Update all the per-item values.
        for item in item_reports.values():
            item_name = item.item_name

            self.known_items.add(item_name)

            # Only care about items where the processing has already started.
            if item.bytes_completed == 0:
                continue

            # Overwrite the existing value in there.
            self.item_state[item_name] = item

        bar_idx = 0
        new_completed = []

        # Now, go through and update all the bars
        for name, item in self.item_state.items():
            # Is this ready to be removed on the next update?
            if item.bytes_completed == item.total_bytes:
                self.completed_items.add(name)
                new_completed.append(name)

            # If we're only showing summary information, then don't update the individual bars
            if not self.per_file_progress:
                continue

            # If we've run out of bars to use, then collapse the last ones together.
            if bar_idx >= len(self.current_bars):
                bar = self.current_bars[-1]
                in_final_bar_mode = True
                final_bar_aggregation_count = bar_idx + 1 - len(self.current_bars)
            else:
                bar = self.current_bars[bar_idx]
                in_final_bar_mode = False

            if bar is None:
                self.current_bars[bar_idx] = tqdm(
                    desc=self.format_desc(name, True),
                    position=2 + bar_idx,  # Set to the position past the initial bars.
                    total=item.total_bytes,
                    initial=item.bytes_completed,
                    **self.tqdm_settings,
                )

            elif in_final_bar_mode:
                bar.n += item.bytes_completed
                bar.total += item.total_bytes
                bar.set_description(self.format_desc(f"[+ {final_bar_aggregation_count} files]", True), refresh=False)
            else:
                bar.set_description(self.format_desc(name, True), refresh=False)
                bar.n = item.bytes_completed
                bar.total = item.total_bytes

            bar_idx += 1

        # Remove all the completed ones from the ordered dictionary
        for name in new_completed:
            # Only remove ones from consideration to make room for more items coming in.
            if len(self.item_state) <= self.n_lines:
                break

            del self.item_state[name]

        if self.per_file_progress:
            # Now manually refresh each of the bars
            for bar in self.current_bars:
                if bar:
                    bar.refresh()

        # Update overall bars
        bytes_inc = max(0, group_report.total_bytes_completed - self._prev_bytes_completed)
        transfer_inc = max(0, group_report.total_transfer_bytes_completed - self._prev_transfer_bytes_completed)
        self._prev_bytes_completed = group_report.total_bytes_completed
        self._prev_transfer_bytes_completed = group_report.total_transfer_bytes_completed

        self.data_processing_bar.total = group_report.total_bytes
        total_files_count = self.total_files if self.total_files is not None else len(self.known_items)
        self.data_processing_bar.set_description(
            self.format_desc(f"Processing Files ({len(self.completed_items)} / {total_files_count})", False),
            refresh=False,
        )
        self.data_processing_bar.set_postfix_str(
            _format_speed_postfix(group_report.total_bytes_completion_rate), refresh=False
        )
        self.data_processing_bar.update(bytes_inc)

        self.upload_bar.total = group_report.total_transfer_bytes
        self.upload_bar.set_postfix_str(
            _format_speed_postfix(group_report.total_transfer_bytes_completion_rate), refresh=False
        )
        self.upload_bar.update(transfer_inc)

    def close(self):
        self.data_processing_bar.close()
        self.upload_bar.close()

        if self.per_file_progress:
            for bar in self.current_bars:
                if bar:
                    bar.close()
