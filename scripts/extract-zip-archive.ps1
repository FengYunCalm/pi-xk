[CmdletBinding()]
param(
	[Parameter(Mandatory = $true)]
	[string]$SourceArchive,
	[Parameter(Mandatory = $true)]
	[string]$DestinationDirectory
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

Add-Type -AssemblyName System.IO.Compression.FileSystem

$resolvedSource = [System.IO.Path]::GetFullPath($SourceArchive)
$resolvedDestination = [System.IO.Path]::GetFullPath($DestinationDirectory)
if (-not [System.IO.File]::Exists($resolvedSource)) {
	throw "Zip archive does not exist: $resolvedSource"
}
if ([System.IO.Directory]::Exists($resolvedDestination) -or [System.IO.File]::Exists($resolvedDestination)) {
	throw "Zip destination already exists: $resolvedDestination"
}

[System.IO.Compression.ZipFile]::ExtractToDirectory($resolvedSource, $resolvedDestination)
