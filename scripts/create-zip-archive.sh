#!/usr/bin/env bash

set -euo pipefail

if [[ $# -ne 2 ]]; then
	echo "Usage: $0 <source-directory> <destination.zip>" >&2
	exit 2
fi

source_directory="$1"
archive_path="$2"

if [[ "$source_directory" != /* ]]; then source_directory="$(pwd -P)/$source_directory"; fi
if [[ "$archive_path" != /* ]]; then archive_path="$(pwd -P)/$archive_path"; fi
if [[ ! -d "$source_directory" ]]; then
	echo "Zip source directory does not exist: $source_directory" >&2
	exit 1
fi

if command -v zip >/dev/null 2>&1; then
	(cd "$source_directory" && zip -r "$archive_path" .)
	exit 0
fi

script_path="${BASH_SOURCE[0]}"
script_directory="${script_path%/*}"
if [[ "$script_directory" == "$script_path" ]]; then script_directory="."; fi
script_directory="$(cd "$script_directory" && pwd -P)"
powershell_script="$script_directory/create-zip-archive.ps1"

if command -v powershell.exe >/dev/null 2>&1 && command -v wslpath >/dev/null 2>&1; then
	if [[ ! -f "$powershell_script" ]]; then
		echo "PowerShell zip helper is missing: $powershell_script" >&2
		exit 1
	fi
	powershell.exe \
		-NoLogo \
		-NoProfile \
		-NonInteractive \
		-ExecutionPolicy Bypass \
		-File "$(wslpath -w "$powershell_script")" \
		-SourceDirectory "$(wslpath -w "$source_directory")" \
		-DestinationPath "$(wslpath -w "$archive_path")"
	if [[ ! -f "$archive_path" ]]; then
		echo "PowerShell zip helper did not create the archive: $archive_path" >&2
		exit 1
	fi
	exit 0
fi

echo "Creating Windows archives requires zip, or powershell.exe plus wslpath when running under WSL" >&2
exit 1
