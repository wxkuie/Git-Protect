param([string]$TaskName = 'LocalGitQuietReminder')
$ErrorActionPreference = 'Stop'
Disable-ScheduledTask -TaskName $TaskName
Stop-ScheduledTask -TaskName $TaskName
