$f = 'c:\Users\rafae\buraco\buraco\buraco-client\src\App.jsx'
$bytes = [System.IO.File]::ReadAllBytes($f)
$c = [System.Text.Encoding]::UTF8.GetString($bytes)

# Gear icon U+2699 was wiped - restore it inside the admin span
# The span is: <span onClick=...title="Modo Admin"></span>
# Need to put gear char back between > and </span>
$gear = [char]9881  # U+2699 GEAR

$bad  = 'title="Modo Admin"></span>'
$good = 'title="Modo Admin">' + $gear + '</span>'
$c = $c.Replace($bad, $good)

$utf8NoBom = New-Object System.Text.UTF8Encoding $false
[System.IO.File]::WriteAllText($f, $c, $utf8NoBom)

$c2 = [System.IO.File]::ReadAllText($f, [System.Text.Encoding]::UTF8)
$i = $c2.IndexOf('Modo Admin')
$seg = $c2.Substring($i+11, 15)
$codes = $seg.ToCharArray() | ForEach-Object { [int]$_ }
Write-Host "After Modo Admin: $codes"
