#!/usr/bin/env python3
"""Fail closed unless /srv/nudge is mounted from the configured EBS volume."""
import json
from pathlib import Path
import re
import subprocess


def verify_identity(volume_id, mount_record, serial):
    if not isinstance(volume_id, str) or not re.fullmatch(r"vol-[a-f0-9]+", volume_id):
        raise ValueError("Invalid configured data volume")
    fields = mount_record.strip().split()
    if len(fields) != 2 or fields[1] != "/srv/nudge" or not fields[0].startswith("/dev/"):
        raise ValueError("Persistent data volume is not mounted directly at /srv/nudge")
    if serial.strip().replace("-", "") != volume_id.replace("-", ""):
        raise ValueError("Mounted data volume does not match the configured EBS volume")


def main():
    try:
        host = json.loads(Path("/etc/nudge/host.json").read_text())
        mount = subprocess.run([
            "findmnt", "--noheadings", "--raw", "--output", "SOURCE,TARGET",
            "--mountpoint", "/srv/nudge",
        ], capture_output=True, text=True, check=True).stdout
        fields = mount.strip().split()
        if len(fields) != 2 or not fields[0].startswith("/dev/"):
            raise ValueError("Persistent data volume mount is invalid")
        serial = subprocess.run([
            "lsblk", "--nodeps", "--noheadings", "--output", "SERIAL", fields[0],
        ], capture_output=True, text=True, check=True).stdout
        verify_identity(host["volumeId"], mount, serial)
    except (ValueError, KeyError, OSError, subprocess.CalledProcessError) as error:
        raise SystemExit("Persistent data volume verification failed; refusing to start or modify data.") from error


if __name__ == "__main__":
    main()
