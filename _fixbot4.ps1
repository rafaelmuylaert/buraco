$f = 'c:\Users\rafae\buraco\buraco\buraco-server\bot.js'
$c = [System.IO.File]::ReadAllText($f, [System.Text.Encoding]::UTF8)
$c = [regex]::Replace($c, "planTurnLogger as _ptl", 'loggerRef')
$utf8NoBom = New-Object System.Text.UTF8Encoding $false
[System.IO.File]::WriteAllText($f, $c, $utf8NoBom)
Write-Host "Done. planTurnLogger remaining: $(($c | Select-String -AllMatches 'planTurnLogger').Matches.Count)"
Write-Host "loggerRef count: $(($c | Select-String -AllMatches 'loggerRef').Matches.Count)"
$c.Substring(0,200)
