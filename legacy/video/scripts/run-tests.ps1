$ErrorActionPreference = 'Stop'

& node (Join-Path $PSScriptRoot 'run-tests.js')
exit $LASTEXITCODE
