#!/bin/sh
set -eu

usage() {
  echo "Usage: sudo ./scripts/put-secret.sh <name> [--from-file <path>] [--replace]" >&2
  exit 2
}

[ "$#" -ge 1 ] || usage
secret_name=$1
shift
source_file=
replace=0

case "$secret_name" in
  ''|*[!A-Za-z0-9._-]*|.*) usage ;;
esac

while [ "$#" -gt 0 ]; do
  case "$1" in
    --from-file)
      [ "$#" -ge 2 ] || usage
      source_file=$2
      shift 2
      ;;
    --replace)
      replace=1
      shift
      ;;
    *) usage ;;
  esac
done

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
secret_dir=$(dirname -- "$script_dir")/secrets
target=$secret_dir/$secret_name
temporary=$secret_dir/.${secret_name}.tmp.$$

install -d -m 0700 -o 1000 -g 1000 "$secret_dir"
if [ -L "$target" ]; then
  echo "Refusing symbolic-link target: $target" >&2
  exit 2
fi
if [ -e "$target" ] && [ "$replace" -ne 1 ]; then
  echo "Secret already exists; use --replace to update it: $target" >&2
  exit 2
fi

trap 'rm -f "$temporary"' EXIT HUP INT TERM
umask 077
if [ -n "$source_file" ]; then
  [ -f "$source_file" ] || { echo "Source is not a regular file: $source_file" >&2; exit 2; }
  cp -- "$source_file" "$temporary"
else
  [ -r /dev/tty ] || { echo "An interactive terminal is required" >&2; exit 2; }
  printf 'Secret: ' >/dev/tty
  IFS= read -r secret_value </dev/tty
  printf '\nConfirm secret: ' >/dev/tty
  IFS= read -r secret_confirmation </dev/tty
  printf '\n' >/dev/tty
  [ "$secret_value" = "$secret_confirmation" ] || { echo "Values do not match" >&2; exit 2; }
  [ -n "$secret_value" ] || { echo "Secret must not be empty" >&2; exit 2; }
  printf '%s\n' "$secret_value" >"$temporary"
  unset secret_value secret_confirmation
fi

chmod 0600 "$temporary"
chown 1000:1000 "$temporary"
mv -f -- "$temporary" "$target"
trap - EXIT HUP INT TERM
echo "Installed $target (owner 1000:1000, mode 0600)"
