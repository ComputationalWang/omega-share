#!/usr/bin/env python3
"""Decide whether a Bash command that uses sudo may run (called by guard.sh).

Board decision 2026-10-08, widened the same day:
  1. Local sudo: a plain file command (chown, chmod, ...) on paths inside this repo or its worktrees.
  2. sudo over ssh/scp/rsync/sftp: full control, but only on the hosted omega-share box
     (SERVER_IP and the PUBLIC_ORIGIN host from the repo's .env, or OMEGA_BOX_HOSTS).
Anything else is denied. Prints a reason and exits 1 to deny; prints nothing and exits 0 to allow.
"""
import json
import os
import re
import shlex
import sys
from urllib.parse import urlparse

LOCAL_CMDS = {"chown", "chmod", "chgrp", "rm", "mv", "cp", "mkdir", "rmdir", "touch", "ln", "ls", "cat"}
REMOTE_CMDS = {"ssh", "scp", "sftp", "rsync"}
WRAPPERS = {"sh", "bash", "zsh", "dash", "fish", "env", "xargs", "eval", "exec", "command", "nohup", "time", "watch",
            "su", "python", "python3", "node", "bun", "perl", "ruby", "timeout", "nice", "setsid", "script"}
SUDO_WORD = re.compile(r"(^|[^A-Za-z0-9_./-])sudo([^A-Za-z0-9_-]|$)")
OPS = {";", "&&", "||", "|", "&", "|&", "(", ")", ">", ">>", "<", ">&", "2>", "&>", "<<", "<<<"}


def deny(reason):
    print(reason)
    sys.exit(1)


def box_hosts(root):
    hosts = set(filter(None, os.environ.get("OMEGA_BOX_HOSTS", "").split(",")))
    try:
        for line in open(os.path.join(root, ".env"), encoding="utf-8"):
            key, _, val = line.strip().partition("=")
            if key == "SERVER_IP" and val:
                hosts.add(val)
            if key == "PUBLIC_ORIGIN" and val:
                host = urlparse(val).hostname
                if host:
                    hosts.add(host)
    except OSError:
        pass
    return hosts


def split_commands(tokens):
    cmds, cur = [], []
    for t in tokens:
        if t in (";", "&&", "||", "|", "&", "|&"):
            if cur:
                cmds.append(cur)
            cur = []
        else:
            cur.append(t)
    if cur:
        cmds.append(cur)
    return cmds


def check_remote(args, hosts):
    seen = False
    for i, t in enumerate(args):
        low = t.lower()
        if low in ("-j",) or "proxyjump" in low or "proxycommand" in low or "localcommand" in low or low.startswith("-j"):
            deny("ssh jump/proxy/local-command options are not allowed.")
        if low == "-o" and i + 1 < len(args) and re.search(r"proxy|localcommand|permitlocalcommand", args[i + 1], re.I):
            deny("ssh proxy/local-command options are not allowed.")
        if " " in t or t.startswith("-"):
            continue  # remote command string or option: not a destination
        m = re.match(r"^(?:[A-Za-z0-9_.-]+@)?(\[[0-9a-fA-F:]+\]|[A-Za-z0-9_.-]+)(?::.*)?$", t)
        if m and "@" in t:
            host = m.group(1).strip("[]")
            if host not in hosts:
                deny(f"sudo over ssh is only allowed on the omega-share box, not {host}.")
            seen = True
        elif m and t in hosts:
            seen = True
    if not seen:
        deny("sudo over ssh needs an explicit user@host of the omega-share box (SERVER_IP in .env).")


def check_local(cmd, root, cwd):
    real_cwd = os.path.realpath(cwd)
    inside = lambda p: p == root or p.startswith(root + "/") or p.startswith(root + "-worktrees/")  # noqa: E731
    if not inside(real_cwd):
        deny("sudo must run from inside the project.")
    rest = cmd[1:]
    if not rest or rest[0] not in LOCAL_CMDS:
        deny("local sudo is only allowed for chown, chmod, chgrp, rm, mv, cp, mkdir, rmdir, touch, ln, ls, cat.")
    for t in rest:
        if "$(" in t or "`" in t or "${" in t:
            deny("sudo arguments must be literal (no substitution).")
        if re.search(r"(^|/)\.\.(/|$)", t):
            deny("sudo with parent-directory paths is not allowed.")
        if t.startswith("~") or t.startswith("$HOME"):
            t = os.path.expanduser(t.replace("$HOME", "~", 1))
        if t.startswith("$"):
            deny(f"sudo paths must be literal ({t}).")
        if t.startswith("/"):
            if not inside(os.path.realpath(t)):
                deny(f"sudo outside the project ({t}) is not allowed.")
        elif os.path.lexists(os.path.join(real_cwd, t)) and not inside(os.path.realpath(os.path.join(real_cwd, t))):
            deny(f"sudo target resolves outside the project ({t}).")


def main():
    data = json.load(sys.stdin)
    cmd = data.get("command", "")
    cwd = data.get("cwd") or "."
    root = data["root"]
    if not SUDO_WORD.search(cmd):
        return
    lex = shlex.shlex(cmd, posix=True, punctuation_chars=True)
    lex.whitespace_split = True
    try:
        tokens = list(lex)
    except ValueError:
        deny("could not parse a command that uses sudo.")
    hosts = box_hosts(root)
    for simple in split_commands(tokens):
        while simple and re.match(r"^[A-Za-z_][A-Za-z0-9_]*=", simple[0]):
            simple = simple[1:]
        if not simple:
            continue
        word = os.path.basename(simple[0])
        has_sudo = any(SUDO_WORD.search(t) for t in simple)
        if word in REMOTE_CMDS:
            if has_sudo:
                check_remote(simple[1:], hosts)
        elif word == "sudo":
            check_local(simple, root, cwd)
        elif has_sudo and word in WRAPPERS:
            deny(f"sudo through {word} is not allowed.")
        # sudo only appearing as plain text (an echo, a commit message, a grep pattern) is fine.


if __name__ == "__main__":
    try:
        main()
    except SystemExit:
        raise
    except Exception as exc:  # fail closed
        print(f"sudo policy error: {exc}")
        sys.exit(1)
