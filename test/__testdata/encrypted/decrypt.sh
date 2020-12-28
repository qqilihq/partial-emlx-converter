#!/bin/bash

# (1) check if one argument was given
if [ $# -eq 0 ]; then
  echo "Usage: $0 «passphrase»" >&2; exit 1
fi

find . -name '*.gpg' -exec gpgtar --decrypt --gpg-args "--batch --passphrase $1" --directory . {} \;
