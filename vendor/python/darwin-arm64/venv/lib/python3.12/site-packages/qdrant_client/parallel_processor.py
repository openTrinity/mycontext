import logging
import os
from collections import defaultdict
from enum import Enum
from multiprocessing import Queue, get_context
from multiprocessing.context import BaseContext
from multiprocessing.process import BaseProcess
from multiprocessing.sharedctypes import Synchronized as BaseValue
from queue import Empty
from typing import Any, Iterable, Type

# Single item should be processed in less than:
processing_timeout = 10 * 60  # seconds

MAX_INTERNAL_BATCH_SIZE = 200


class QueueSignals(str, Enum):
    stop = "stop"
    confirm = "confirm"
    error = "error"


class Worker:
    @classmethod
    def start(cls, *args: Any, **kwargs: Any) -> "Worker":
        raise NotImplementedError()

    def process(self, items: Iterable[Any]) -> Iterable[Any]:
        raise NotImplementedError()


def _worker(
    worker_class: Type[Worker],
    input_queue: Queue,
    output_queue: Queue,
    num_active_workers: BaseValue,
    worker_id: int,
    kwargs: dict[str, Any] | None = None,
) -> None:
    """
    A worker that pulls data pints off the input queue, and places the execution result on the output queue.
    When there are no data pints left on the input queue, it decrements
    num_active_workers to signal completion.
    """

    if kwargs is None:
        kwargs = {}

    logging.info(f"Reader worker: {worker_id} PID: {os.getpid()}")
    try:
        worker = worker_class.start(**kwargs)

        # Keep going until you get an item that's None.
        def input_queue_iterable() -> Iterable[Any]:
            while True:
                item = input_queue.get()
                if item == QueueSignals.stop:
                    break
                yield item

        for processed_item in worker.process(input_queue_iterable()):
            output_queue.put(processed_item)
    except Exception as e:  # pylint: disable=broad-except
        logging.exception(e)
        output_queue.put(QueueSignals.error)
    finally:
        # It's important that we close and join the queue here before
        # decrementing num_active_workers. Otherwise our parent may join us
        # before the queue's feeder thread has passed all buffered items to
        # the underlying pipe resulting in a deadlock.
        #
        # See:
        # https://docs.python.org/3.6/library/multiprocessing.html?highlight=process#pipes-and-queues
        # https://docs.python.org/3.6/library/multiprocessing.html?highlight=process#programming-guidelines
        input_queue.close()
        output_queue.close()
        input_queue.join_thread()
        output_queue.join_thread()

        with num_active_workers.get_lock():
            num_active_workers.value -= 1

        logging.info(f"Reader worker {worker_id} finished")


class ParallelWorkerPool:
    def __init__(
        self,
        num_workers: int,
        worker: Type[Worker],
        start_method: str | None = None,
        max_internal_batch_size: int = MAX_INTERNAL_BATCH_SIZE,
    ):
        self.worker_class = worker
        self.num_workers = num_workers
        self.input_queue: Queue | None = None
        self.output_queue: Queue | None = None
        self.ctx: BaseContext = get_context(start_method)
        self.processes: list[BaseProcess] = []
        self.queue_size = self.num_workers * max_internal_batch_size
        self.emergency_shutdown = False
        self.num_active_workers: BaseValue | None = None

    def start(self, **kwargs: Any) -> None:
        self.input_queue = self.ctx.Queue(self.queue_size)
        self.output_queue = self.ctx.Queue(self.queue_size)

        ctx_value = self.ctx.Value("i", self.num_workers)
        assert isinstance(ctx_value, BaseValue)
        self.num_active_workers = ctx_value

        for worker_id in range(0, self.num_workers):
            assert hasattr(self.ctx, "Process")
            process = self.ctx.Process(
                target=_worker,
                args=(
                    self.worker_class,
                    self.input_queue,
                    self.output_queue,
                    self.num_active_workers,
                    worker_id,
                    kwargs.copy(),
                ),
            )
            process.start()
            self.processes.append(process)

    def unordered_map(self, stream: Iterable[Any], *args: Any, **kwargs: Any) -> Iterable[Any]:
        try:
            self.start(**kwargs)

            assert self.input_queue is not None, "Input queue was not initialized"
            assert self.output_queue is not None, "Output queue was not initialized"

            pushed = 0
            read = 0
            for item in stream:
                self.check_worker_health()
                if pushed - read < self.queue_size:
                    try:
                        out_item = self.output_queue.get_nowait()
                    except Empty:
                        out_item = None
                else:
                    try:
                        out_item = self.output_queue.get(timeout=processing_timeout)
                    except Empty as e:
                        self.join_or_terminate()
                        raise e

                if out_item is not None:
                    if out_item == QueueSignals.error:
                        self.join_or_terminate()
                        raise RuntimeError("Thread unexpectedly terminated")
                    yield out_item
                    read += 1
                self.input_queue.put(item)
                pushed += 1

            for _ in range(self.num_workers):
                self.input_queue.put(QueueSignals.stop)

            while read < pushed:
                out_item = self.output_queue.get(timeout=processing_timeout)
                if out_item == QueueSignals.error:
                    self.join_or_terminate()
                    raise RuntimeError("Thread unexpectedly terminated")
                yield out_item
                read += 1
        finally:
            assert self.input_queue is not None, "Input queue is None"
            assert self.output_queue is not None, "Output queue is None"
            self.join()
            self.input_queue.close()
            self.output_queue.close()
            if self.emergency_shutdown:
                self.input_queue.cancel_join_thread()
                self.output_queue.cancel_join_thread()
            else:
                self.input_queue.join_thread()
                self.output_queue.join_thread()

    def semi_ordered_map(self, stream: Iterable[Any], *args: Any, **kwargs: Any) -> Iterable[Any]:
        return self.unordered_map(enumerate(stream), *args, **kwargs)

    def ordered_map(self, stream: Iterable[Any], *args: Any, **kwargs: Any) -> Iterable[Any]:
        buffer = defaultdict(int)
        next_expected = 0

        for idx, item in self.semi_ordered_map(stream, *args, **kwargs):
            buffer[idx] = item
            while next_expected in buffer:
                yield buffer.pop(next_expected)
                next_expected += 1

    def check_worker_health(self) -> None:
        """
        Checks if any worker process has terminated unexpectedly
        """
        for process in self.processes:
            if not process.is_alive() and process.exitcode != 0:
                self.emergency_shutdown = True
                self.join_or_terminate()
                raise RuntimeError(
                    f"Worker PID: {process.pid} terminated unexpectedly with code {process.exitcode}"
                )

    def join_or_terminate(self, timeout: int | None = 1) -> None:
        """
        Emergency shutdown
        @param timeout:
        @return:
        """
        self.emergency_shutdown = True
        for process in self.processes:
            process.join(timeout=timeout)
            if process.is_alive():
                process.terminate()
        self.processes.clear()

    def join(self) -> None:
        for process in self.processes:
            process.join()
        self.processes.clear()

    def __del__(self) -> None:
        """
        Terminate processes if the user hasn't joined. This is necessary as
        leaving stray processes running can corrupt shared state. In brief,
        we've observed shared memory counters being reused (when the memory was
        free from the perspective of the parent process) while the stray
        workers still held a reference to them.
        For a discussion of using destructors in Python in this manner, see
        https://eli.thegreenplace.net/2009/06/12/safely-using-destructors-in-python/.
        """
        for process in self.processes:
            if process.is_alive():
                process.terminate()
