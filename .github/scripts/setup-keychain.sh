#!/bin/sh
# Create a throwaway keychain and make it the default one, so that tests never touch a real keychain.
# Meant for disposable CI runners: it changes the user's keychain search list.
set -eu

KEYCHAIN="${RUNNER_TEMP:-/tmp}/ci.keychain-db"
PASSWORD="ci-$(date +%s)"

security create-keychain -p "$PASSWORD" "$KEYCHAIN"
security set-keychain-settings -lut 21600 "$KEYCHAIN"
security unlock-keychain -p "$PASSWORD" "$KEYCHAIN"
security default-keychain -d user -s "$KEYCHAIN"
# shellcheck disable=SC2046
security list-keychains -d user -s "$KEYCHAIN" $(security list-keychains -d user | tr -d '"')

security list-keychains -d user
security default-keychain -d user
