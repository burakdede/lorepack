#!/usr/bin/env bash
# Runs the privacy test inside a fresh network and mount namespace. Needs root, so it is
# meant for the Linux CI job: `sudo unshare --net --mount -- bash netns.sh`.
#
# The namespace has a loopback and a dummy interface holding the default route. A packet to
# any address, including a DNS query, is transmitted on one of them, counted, and dropped.
# resolv.conf and nsswitch.conf are replaced inside the mount namespace so name lookups go
# to a nameserver on the dummy network rather than through a host daemon's Unix socket,
# which a network namespace would not stop.
set -euo pipefail

ip link set lo up
ip link add dummy0 type dummy
ip addr add 10.203.0.1/24 dev dummy0
ip link set dummy0 up
ip route add default via 10.203.0.2 dev dummy0

scratch="$(mktemp -d)"
printf 'nameserver 10.203.0.2\n' >"$scratch/resolv.conf"
printf 'hosts: files dns\n' >"$scratch/nsswitch.conf"
mount --bind "$scratch/resolv.conf" /etc/resolv.conf
mount --bind "$scratch/nsswitch.conf" /etc/nsswitch.conf

export LORE_PRIVACY_NETNS=1
exec pnpm exec vitest run --root tools/security test/privacy-defaults.test.ts
