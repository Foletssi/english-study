param(
  [string]$Python = "python"
)

$ErrorActionPreference = "Stop"
& $Python -m services.worker.worker

