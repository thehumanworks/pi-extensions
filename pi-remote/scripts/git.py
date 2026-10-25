#!/usr/bin/env python3
"""Run Git by default; use `gh ...` explicitly for GitHub CLI commands.

For compatibility, `auth ...` is also routed to gh.
"""
import os
import subprocess
import sys


def run_git(args: list[str], is_personal: bool = True) -> int:
    env = os.environ.copy()
    env.pop("GH_TOKEN", None)
    env["GH_HOST"] = "github.com" if is_personal else "leadforensics.ghe.com"
    if args and args[0] in {"git", "gh"}:
        command = args
    elif args and args[0] == "auth":
        command = ["gh", *args]
    else:
        command = ["git", *args]
    try:
        return subprocess.run(command, env=env, check=False).returncode
    except FileNotFoundError:
        print(f"Executable not found: {command[0]}", file=sys.stderr)
        return 127


if __name__ == "__main__":
    if len(sys.argv) < 3 or sys.argv[1] not in {"personal", "work"}:
        sys.exit("usage: git.py <personal|work> [git|gh] <args>")
    sys.exit(run_git(sys.argv[2:], sys.argv[1] == "personal"))
