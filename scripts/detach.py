#!/usr/bin/env python3
"""Detach a long-running process so it survives the calling shell.

The bash tool (and similar wrappers) kill the process tree when the command
returns or times out, so `nohup node server.js &` does not survive. This
launcher double-forks: the original parent exits immediately (so the caller
returns right away), an intermediate child exits, and the grandchild becomes a
session leader that keeps running with stdio redirected to a log file.

Usage:
    python3 scripts/detach.py <workdir> <logfile> <cmd> [args...]

Examples:
    python3 scripts/detach.py buraco-server server.log node server.js
    python3 scripts/detach.py buraco-server bot.log node bot.js

The detached process is NOT tracked; find it with:
    for p in $(ls /proc | grep -E '^[0-9]+$'); do
      tr '\0' ' ' < /proc/$p/cmdline 2>/dev/null | grep -q 'node server.js' && echo $p
    done
and stop it with `kill <pid>`.
"""
import os
import sys


def main() -> None:
    if len(sys.argv) < 4:
        sys.stderr.write(__doc__ or "")
        sys.exit(1)

    workdir, logfile, cmd = sys.argv[1], sys.argv[2], sys.argv[3]
    argv = [cmd] + sys.argv[4:]

    # Fork 1: the original parent exits so the caller returns immediately.
    if os.fork() > 0:
        sys.exit(0)

    # Fork 2: the intermediate child exits; the grandchild becomes the daemon.
    if os.fork() > 0:
        os._exit(0)

    os.setsid()
    os.chdir(workdir)

    devnull = os.open(os.devnull, os.O_RDWR)
    os.dup2(devnull, 0)
    log = os.open(logfile, os.O_WRONLY | os.O_CREAT | os.O_APPEND)
    os.dup2(log, 1)
    os.dup2(log, 2)
    os.execvp(cmd, argv)


if __name__ == "__main__":
    main()
