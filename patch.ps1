$file = 'buraco-client/src/game.js'
$src = [System.IO.File]::ReadAllText($file)
$cr = [char]13; $lf = [char]10; $crlf = $cr.ToString() + $lf.ToString()
$d = [char]36; $bt = [char]96

$old = 'appendCardsToMeld(meld, cards, G.rules, suit);' + $crlf + '                        const sig = ' + $bt + 'pickup-seq-'
$new = 'appendCardsToMeld(meld, cards, G.rules, suit);' + $crlf + '                        if (!parsed) continue;' + $crlf + '                        const handUsed = cards.filter(c => c !== topDiscard);' + $crlf + '                        const sig = ' + $bt + 'pickup-seq-'

$src2 = $src.Replace($old, $new)
if ($src2 -eq $src) { [Console]::WriteLine('NO CHANGE'); exit 1 }
[System.IO.File]::WriteAllText($file, $src2)
[Console]::WriteLine('Done')
