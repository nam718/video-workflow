$zip = 'C:\Users\NAN\Desktop\VideoWorkflow.zip'
$tmp = 'C:\Users\NAN\Desktop\__vw_update_tmp'
$dst = 'C:\Users\NAN\Desktop\VideoWorkflow-Test'

if (Test-Path $tmp) {
  Remove-Item $tmp -Recurse -Force
}

New-Item -ItemType Directory -Path $tmp | Out-Null
Expand-Archive -LiteralPath $zip -DestinationPath $tmp -Force
robocopy ($tmp + '\VideoWorkflow') $dst /MIR /R:1 /W:1 /NFL /NDL /NJH /NJS /NP
$code = $LASTEXITCODE
Remove-Item $tmp -Recurse -Force

exit $code
