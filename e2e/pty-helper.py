#!/usr/bin/env python3
# Pseudo-terminal helper for e2e/ptyDriver.mjs (no native addons): stdlib pty + termios + fcntl only.
#
#   python3 -I e2e/pty-helper.py --pidfile F --cols C --rows R -- <command> [args...]
#
# Opens a pty of C x R, starts <command> on it as the foreground job of its own process group (so SIGTSTP really stops
# it: a pty session leader's own group would be orphaned and the kernel discards job-control stops there), relays this
# process's stdin to the pty and the pty's output to stdout byte for byte, and writes the command's pid to F (and its
# exit code, 128 + signal when killed, to F.exit). Control lines on fd 3 (when open): "resize C R" sets the window size
# (TIOCSWINSZ on the master, so the kernel sends SIGWINCH to the foreground job). SIGUSR1 re-reads F.size ("C R").
# Exits with the command's exit code once it ends and its output is drained.
import errno
import fcntl
import os
import select
import signal
import struct
import sys
import termios


def set_size(fd, cols, rows):
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', rows, cols, 0, 0))


def write_atomic(path, text):
    tmp = path + '.tmp'
    with open(tmp, 'w') as f:
        f.write(text)
    os.replace(tmp, path)


def main():
    argv = sys.argv[1:]
    if '--' not in argv:
        sys.stderr.write('usage: pty-helper.py --pidfile F --cols C --rows R -- command...\n')
        return 2
    sep = argv.index('--')
    opts, cmd = argv[:sep], argv[sep + 1:]
    o = {}
    for i in range(0, len(opts) - 1, 2):
        o[opts[i]] = opts[i + 1]
    pidfile = o.get('--pidfile')
    cols = int(o.get('--cols', '80'))
    rows = int(o.get('--rows', '24'))
    if not cmd or not pidfile:
        return 2

    master, slave = os.openpty()
    set_size(master, cols, rows)
    leader = os.fork()
    if leader == 0:
        # Session leader on the pty; the command runs as a separate, non-orphaned foreground process group.
        os.close(master)
        os.setsid()
        fcntl.ioctl(slave, termios.TIOCSCTTY, 0)
        for fd in (0, 1, 2):
            os.dup2(slave, fd)
        if slave > 2:
            os.close(slave)
        child = os.fork()
        if child == 0:
            os.setpgid(0, 0)
            signal.signal(signal.SIGTTOU, signal.SIG_IGN)
            os.tcsetpgrp(0, os.getpgrp())
            signal.signal(signal.SIGTTOU, signal.SIG_DFL)
            try:
                os.execvp(cmd[0], cmd)
            except OSError:
                os._exit(127)
        try:
            os.setpgid(child, child)
        except OSError:
            pass
        write_atomic(pidfile, str(child))
        while True:
            try:
                _, status = os.waitpid(child, os.WUNTRACED)
            except ChildProcessError:
                os._exit(1)
            except InterruptedError:
                continue
            if os.WIFSTOPPED(status):
                continue
            code = os.WEXITSTATUS(status) if os.WIFEXITED(status) else 128 + os.WTERMSIG(status)
            write_atomic(pidfile + '.exit', str(code))
            os._exit(code)

    os.close(slave)

    def on_usr1(_sig, _frm):
        try:
            with open(pidfile + '.size') as f:
                c, r = f.read().split()[:2]
            set_size(master, int(c), int(r))
        except (OSError, ValueError):
            pass

    signal.signal(signal.SIGUSR1, on_usr1)
    signal.signal(signal.SIGPIPE, signal.SIG_DFL)

    inputs = [0, master]
    try:
        os.fstat(3)
        inputs.append(3)
    except OSError:
        pass
    ctl_buf = b''
    leader_status = None
    out = sys.stdout.buffer
    while True:
        try:
            ready, _, _ = select.select(inputs, [], [], 0.05)
        except InterruptedError:
            continue
        if leader_status is not None and not ready:
            break  # drained (a process the command left behind may still hold the pty open)
        if master in ready:
            try:
                data = os.read(master, 65536)
            except OSError as e:
                if e.errno in (errno.EIO, errno.EBADF):
                    data = b''
                else:
                    raise
            if not data:
                break
            out.write(data)
            out.flush()
        if 0 in ready:
            data = os.read(0, 65536)
            if not data:
                inputs.remove(0)
            else:
                os.write(master, data)
        if 3 in ready:
            data = os.read(3, 4096)
            if not data:
                inputs.remove(3)
            else:
                ctl_buf += data
                while b'\n' in ctl_buf:
                    line, ctl_buf = ctl_buf.split(b'\n', 1)
                    parts = line.decode('ascii', 'replace').split()
                    if len(parts) == 3 and parts[0] == 'resize':
                        set_size(master, int(parts[1]), int(parts[2]))
        if leader_status is None:
            pid, status = os.waitpid(leader, os.WNOHANG)
            if pid == leader:
                leader_status = status
                # Drain what is left, then stop.
                inputs = [master]
    if leader_status is None:
        _, leader_status = os.waitpid(leader, 0)
    return os.WEXITSTATUS(leader_status) if os.WIFEXITED(leader_status) else 128 + os.WTERMSIG(leader_status)


if __name__ == '__main__':
    sys.exit(main())
