#!/usr/bin/env bash

set -euo pipefail

if [[ $# -ne 2 ]]; then
	echo "Usage: $0 <source.zip> <destination-directory>" >&2
	exit 2
fi

archive_path="$1"
destination_directory="$2"

if [[ "$archive_path" != /* ]]; then archive_path="$(pwd -P)/$archive_path"; fi
if [[ "$destination_directory" != /* ]]; then destination_directory="$(pwd -P)/$destination_directory"; fi
if [[ ! -f "$archive_path" ]]; then
	echo "Zip archive does not exist: $archive_path" >&2
	exit 1
fi
if [[ -e "$destination_directory" ]]; then
	echo "Zip destination already exists: $destination_directory" >&2
	exit 1
fi

if command -v unzip >/dev/null 2>&1; then
	mkdir -p "$destination_directory"
	unzip -q "$archive_path" -d "$destination_directory"
	exit 0
fi

script_path="${BASH_SOURCE[0]}"
script_directory="${script_path%/*}"
if [[ "$script_directory" == "$script_path" ]]; then script_directory="."; fi
script_directory="$(cd "$script_directory" && pwd -P)"
powershell_script="$script_directory/extract-zip-archive.ps1"

if command -v powershell.exe >/dev/null 2>&1 && command -v wslpath >/dev/null 2>&1; then
	if [[ ! -f "$powershell_script" ]]; then
		echo "PowerShell unzip helper is missing: $powershell_script" >&2
		exit 1
	fi
	powershell.exe \
		-NoLogo \
		-NoProfile \
		-NonInteractive \
		-ExecutionPolicy Bypass \
		-File "$(wslpath -w "$powershell_script")" \
		-SourceArchive "$(wslpath -w "$archive_path")" \
		-DestinationDirectory "$(wslpath -w "$destination_directory")"
	if [[ ! -d "$destination_directory" ]]; then
		echo "PowerShell unzip helper did not create the destination: $destination_directory" >&2
		exit 1
	fi
	exit 0
fi

echo "Extracting Windows archives requires unzip, or powershell.exe plus wslpath when running under WSL" >&2
exit 1
