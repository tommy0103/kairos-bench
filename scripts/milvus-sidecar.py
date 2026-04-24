#!/usr/bin/env python3
"""Milvus-lite sidecar — starts an embedded Milvus server on gRPC :19530."""

import os
import signal
import sys
import time

DATA_DIR = os.environ.get("MILVUS_DATA_DIR", "./data/milvus")
PORT = int(os.environ.get("MILVUS_PORT", "19530"))
READY_FILE = os.environ.get("MILVUS_READY_FILE", "/tmp/milvus-ready")


def main():
    try:
        from milvus import default_server
    except ImportError:
        print("milvus-lite not installed. Run: pip install milvus-lite", file=sys.stderr)
        sys.exit(1)

    os.makedirs(DATA_DIR, exist_ok=True)
    default_server.set_base_dir(DATA_DIR)

    def shutdown(*_):
        print("[milvus-sidecar] shutting down...")
        try:
            os.remove(READY_FILE)
        except FileNotFoundError:
            pass
        default_server.stop()
        sys.exit(0)

    signal.signal(signal.SIGTERM, shutdown)
    signal.signal(signal.SIGINT, shutdown)

    print(f"[milvus-sidecar] starting on port {PORT}, data_dir={DATA_DIR}")
    default_server.listen_port = PORT
    default_server.start()

    with open(READY_FILE, "w") as f:
        f.write(str(PORT))
    print(f"[milvus-sidecar] ready on :{PORT}")

    while True:
        time.sleep(60)


if __name__ == "__main__":
    main()
