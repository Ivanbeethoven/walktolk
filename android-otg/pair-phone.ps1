[CmdletBinding()]
param(
    [Parameter(Mandatory)] [string] $Serial,
    [Parameter(Mandatory)] [string] $RelayCertificate,
    [Parameter(Mandatory)] [uri] $RelayUrl,
    [string] $Adb = 'adb.exe',
    [string] $DshDirectory = (Join-Path $env:USERPROFILE '.dsh')
)

$ErrorActionPreference = 'Stop'
if ($RelayUrl.Scheme -ne 'wss' -or $RelayUrl.AbsolutePath -ne '/deck/usb' -or
    $RelayUrl.Query -or $RelayUrl.Fragment -or $RelayUrl.UserInfo) {
    throw 'Expected a wss:// relay URL with path /deck/usb'
}
$profileText = [IO.File]::ReadAllText((Join-Path $DshDirectory 'profiles/desktop/cordis.patch.yml'))
$bridge = [regex]::Match($profileText, '(?ms)^      name: dsh-ssh-bridge\s*\r?\n(.*?)(?=^\S|^    - |\z)')
if (!$bridge.Success) { throw 'Desktop relay configuration was not found' }
function Read-RelaySetting([string] $Name) {
    $entry = [regex]::Match($bridge.Groups[1].Value, ('(?m)^          ' + $Name + ':[ \t]*([^\r\n#]+)'))
    if ($entry.Success) { return $entry.Groups[1].Value.Trim().Trim('"', "'") }
    return ''
}
$key = [IO.File]::ReadAllText((Join-Path $DshDirectory 'deck-bridge.key')).Trim()
$access = Read-RelaySetting 'accessToken'
if (!$access -or $key.Length -lt 32) { throw 'Desktop pairing credentials are missing' }
$hostId = Read-RelaySetting 'hostId'
if (!$hostId) { $hostId = 'default' }
$cert = [Security.Cryptography.X509Certificates.X509Certificate2]::CreateFromPem(
    [IO.File]::ReadAllText((Get-Item -LiteralPath $RelayCertificate).FullName))
$pair = @{
    url = $RelayUrl.AbsoluteUri
    cookie = "dsh_relay=$access; dsh_host=$hostId"
    key = $key
    cert = [Convert]::ToBase64String($cert.RawData)
} | ConvertTo-Json -Compress
& $Adb -s $Serial shell run-as dev.dsh.otg mkdir -p no_backup
if ($LASTEXITCODE -ne 0) { throw 'Could not open the installed app data directory' }
$pair | & $Adb -s $Serial shell -T run-as dev.dsh.otg tee no_backup/deck-pairing.tmp | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Pairing transfer failed' }
& $Adb -s $Serial shell run-as dev.dsh.otg mv no_backup/deck-pairing.tmp no_backup/deck-pairing.json
if ($LASTEXITCODE -ne 0) { throw 'Could not activate pairing' }
'Installed desktop pairing in the app private directory.'
