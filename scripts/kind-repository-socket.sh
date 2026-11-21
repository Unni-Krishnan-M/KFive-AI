#!/bin/sh
# Run only inside the owned kfive-control-plane container, before pod creation.
# No persistent data or host-machine path is mounted or changed here.
set -eu
directory=/run/kfive-repository-importer
fail() { echo 'Unsafe kind repository socket directory; refusing provisioning.' >&2; exit 1; }
[ "$(id -u)" = 0 ] || fail
[ ! -L /run ] && [ -d /run ] || fail
if [ ! -e "$directory" ] && [ ! -L "$directory" ]; then
  mkdir -m 0700 "$directory"
  mount -t tmpfs -o size=1m,mode=0770,uid=10001,gid=10002,noexec,nosuid,nodev \
    kfive-repository-importer "$directory"
fi
[ ! -L "$directory" ] && [ -d "$directory" ] || fail
[ "$(stat -c '%u:%g:%a' "$directory")" = '10001:10002:770' ] || fail
[ "$(findmnt -rn -M "$directory" -o SOURCE)" = kfive-repository-importer ] || fail
[ "$(findmnt -rn -M "$directory" -o FSTYPE)" = tmpfs ] || fail
options=$(findmnt -rn -M "$directory" -o OPTIONS)
for required in noexec nosuid nodev size=1024k; do
  case ",$options," in *",$required,"*) ;; *) fail ;; esac
done
for entry in "$directory"/* "$directory"/.[!.]* "$directory"/..?*; do
  [ -e "$entry" ] || [ -L "$entry" ] || continue
  [ "$entry" = "$directory/importer.sock" ] || fail
  [ ! -L "$entry" ] && [ -S "$entry" ] || fail
  [ "$(stat -c '%u:%g:%a' "$entry")" = '10001:10002:660' ] || fail
done
echo 'kind repository socket directory verified'
