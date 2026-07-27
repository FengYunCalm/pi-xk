[CmdletBinding()]
param(
	[Parameter(Mandatory = $true)]
	[string]$SourceDirectory,
	[Parameter(Mandatory = $true)]
	[string]$DestinationPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

Add-Type -AssemblyName System.IO.Compression.FileSystem

$resolvedSource = [System.IO.Path]::GetFullPath($SourceDirectory)
$resolvedDestination = [System.IO.Path]::GetFullPath($DestinationPath)
if (-not [System.IO.Directory]::Exists($resolvedSource)) {
	throw "Zip source directory does not exist: $resolvedSource"
}

$destinationDirectory = [System.IO.Path]::GetDirectoryName($resolvedDestination)
if (-not [System.IO.Directory]::Exists($destinationDirectory)) {
	[System.IO.Directory]::CreateDirectory($destinationDirectory) | Out-Null
}
if ([System.IO.File]::Exists($resolvedDestination)) {
	[System.IO.File]::Delete($resolvedDestination)
}

[System.IO.Compression.ZipFile]::CreateFromDirectory(
	$resolvedSource,
	$resolvedDestination,
	[System.IO.Compression.CompressionLevel]::Optimal,
	$false
)
