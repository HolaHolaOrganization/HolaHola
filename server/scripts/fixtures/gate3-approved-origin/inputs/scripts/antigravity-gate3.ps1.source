[CmdletBinding()]
param(
    [Parameter(Mandatory = $true, Position = 0)]
    [ValidateSet('initialize', 'prepare', 'run', 'status')]
    [string]$Action,

    [Parameter(Mandatory = $false)]
    [string]$StartingCommit
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

$ApprovedWorktree = 'C:\Users\David\HolaHola-antigravity'
$StoreVersion = 1
$StoreDirectory = [System.IO.Path]::Combine(
    [Environment]::GetFolderPath([Environment+SpecialFolder]::LocalApplicationData),
    'HolaHola',
    'coordination'
)
$ActiveStore = [System.IO.Path]::Combine($StoreDirectory, 'antigravity-bootstrap.dpapi')
$InFlightStore = [System.IO.Path]::Combine($StoreDirectory, 'antigravity-bootstrap.inflight')
$PrepareBundle = [System.IO.Path]::Combine($StoreDirectory, 'antigravity-prepare.mjs')
$RunBundle = [System.IO.Path]::Combine($StoreDirectory, 'antigravity-run.mjs')
$PrepareBundleSha256 = '06ce0e36c270bb3796e5b528ceee0200bc334991c0bd512b64ac80d0ddd475ab'
$RunBundleSha256 = '5e620f6bc4cc5fb2dcf869efbfbbecc79a995178439e30191ada5b19d273363e'
$Entropy = [System.Text.Encoding]::UTF8.GetBytes('HolaHola Antigravity Gate 3 DPAPI v1')
$BootstrapPattern = '^cb_[A-Za-z0-9_-]{43}$'
$script:ApprovedNodePath = $null

function Fail {
    param([Parameter(Mandatory = $true)][string]$Code)
    throw "antigravity_gate3_$Code"
}

function Assert-WindowsRuntime {
    if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) {
        Fail 'windows_required'
    }
    if ($PSVersionTable.PSVersion.Major -lt 5) {
        Fail 'powershell_5_1_required'
    }
    if ($PSVersionTable.PSVersion.Major -eq 5 -and $PSVersionTable.PSVersion.Minor -lt 1) {
        Fail 'powershell_5_1_required'
    }
    if ($PSVersionTable.PSVersion.Major -eq 5) {
        try {
            Add-Type -AssemblyName System.Security -ErrorAction Stop
        } catch {
            Fail 'dpapi_unavailable'
        }
    }
    if ($null -eq ('System.Security.Cryptography.ProtectedData' -as [type])) {
        Fail 'dpapi_unavailable'
    }
}

function Assert-NoFixedActorTokens {
    foreach ($name in @('COORDINATION_LUCA_GEMINI_CODE_TOKEN', 'COORDINATION_LUCA_GEMINI_TOKEN')) {
        if ($null -ne [Environment]::GetEnvironmentVariable($name, 'Process')) {
            Fail 'fixed_actor_token'
        }
    }
}

function Assert-NoReparsePoint {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][bool]$MustExist
    )
    if (-not [System.IO.File]::Exists($Path) -and -not [System.IO.Directory]::Exists($Path)) {
        if ($MustExist) { Fail 'store_missing' }
        return
    }
    $item = Get-Item -LiteralPath $Path -Force
    if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
        Fail 'reparse_point'
    }
}

function Assert-NoReparseChain {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][bool]$MustExist
    )
    $fullPath = [System.IO.Path]::GetFullPath($Path)
    if ($MustExist -and -not [System.IO.File]::Exists($fullPath) -and -not [System.IO.Directory]::Exists($fullPath)) {
        Fail 'path_missing'
    }
    $current = $fullPath
    while (-not [string]::IsNullOrWhiteSpace($current)) {
        if ([System.IO.File]::Exists($current) -or [System.IO.Directory]::Exists($current)) {
            Assert-NoReparsePoint -Path $current -MustExist $true
        }
        $parent = [System.IO.Directory]::GetParent($current)
        if ($null -eq $parent) { break }
        $current = $parent.FullName
    }
}

function Get-CurrentUserSid {
    $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
    if ($null -eq $identity -or $null -eq $identity.User) {
        Fail 'windows_identity'
    }
    return $identity.User
}

function Set-PrivateAcl {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][bool]$Directory
    )
    $sid = Get-CurrentUserSid
    if ($Directory) {
        $security = New-Object System.Security.AccessControl.DirectorySecurity
        $inheritance = [System.Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit'
    } else {
        $security = New-Object System.Security.AccessControl.FileSecurity
        $inheritance = [System.Security.AccessControl.InheritanceFlags]::None
    }
    $security.SetAccessRuleProtection($true, $false)
    $security.SetOwner($sid)
    $rule = New-Object System.Security.AccessControl.FileSystemAccessRule(
        $sid,
        [System.Security.AccessControl.FileSystemRights]::FullControl,
        $inheritance,
        [System.Security.AccessControl.PropagationFlags]::None,
        [System.Security.AccessControl.AccessControlType]::Allow
    )
    [void]$security.AddAccessRule($rule)
    if ($Directory) {
        [System.IO.Directory]::SetAccessControl($Path, $security)
    } else {
        [System.IO.File]::SetAccessControl($Path, $security)
    }
}

function Assert-PrivateAcl {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][bool]$Directory
    )
    $sid = Get-CurrentUserSid
    if ($Directory) {
        $security = [System.IO.Directory]::GetAccessControl($Path)
    } else {
        $security = [System.IO.File]::GetAccessControl($Path)
    }
    if (-not $security.AreAccessRulesProtected) { Fail 'acl_inheritance' }
    $owner = New-Object System.Security.Principal.SecurityIdentifier($security.GetOwner([System.Security.Principal.SecurityIdentifier]).Value)
    if ($owner.Value -ne $sid.Value) { Fail 'acl_owner' }
    $rules = $security.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])
    if ($rules.Count -lt 1) { Fail 'acl_empty' }
    foreach ($rule in $rules) {
        if ($rule.IdentityReference.Value -ne $sid.Value) { Fail 'acl_principal' }
        if ($rule.AccessControlType -ne [System.Security.AccessControl.AccessControlType]::Allow) {
            Fail 'acl_deny'
        }
        if (($rule.FileSystemRights -band [System.Security.AccessControl.FileSystemRights]::FullControl) -ne [System.Security.AccessControl.FileSystemRights]::FullControl) {
            Fail 'acl_rights'
        }
    }
}

function Ensure-StoreDirectory {
    if (-not [System.IO.Directory]::Exists($StoreDirectory)) {
        [void][System.IO.Directory]::CreateDirectory($StoreDirectory)
        Set-PrivateAcl -Path $StoreDirectory -Directory $true
    }
    Assert-NoReparseChain -Path $StoreDirectory -MustExist $true
    Assert-PrivateAcl -Path $StoreDirectory -Directory $true
}

function Assert-ApprovedWorktree {
    if (-not [System.IO.Directory]::Exists($ApprovedWorktree)) {
        Fail 'approved_worktree_missing'
    }
    Assert-NoReparseChain -Path $ApprovedWorktree -MustExist $true
    $resolved = (Get-Item -LiteralPath $ApprovedWorktree -Force).FullName.TrimEnd('\')
    if (-not [string]::Equals($resolved, $ApprovedWorktree, [StringComparison]::OrdinalIgnoreCase)) {
        Fail 'approved_worktree'
    }
}

function Get-Sha256 {
    param([Parameter(Mandatory = $true)][string]$Path)
    return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Resolve-ApprovedNode {
    $commands = @(Get-Command node.exe -CommandType Application -ErrorAction Stop)
    if ($commands.Count -ne 1) { Fail 'node_resolution' }
    $nodePath = [System.IO.Path]::GetFullPath($commands[0].Source)
    Assert-NoReparseChain -Path $nodePath -MustExist $true
    $signature = Get-AuthenticodeSignature -LiteralPath $nodePath
    if ($signature.Status -ne [System.Management.Automation.SignatureStatus]::Valid) {
        Fail 'node_signature'
    }
    $version = [System.Diagnostics.FileVersionInfo]::GetVersionInfo($nodePath)
    if ($version.ProductName -ne 'Node.js') { Fail 'node_product' }
    return [pscustomobject]@{
        Path = $nodePath
        Sha256 = Get-Sha256 -Path $nodePath
    }
}

function Assert-ApprovedNode {
    param(
        [Parameter(Mandatory = $true)][string]$ExpectedPath,
        [Parameter(Mandatory = $true)][string]$ExpectedSha256
    )
    $node = Resolve-ApprovedNode
    if (-not [string]::Equals($node.Path, $ExpectedPath, [StringComparison]::OrdinalIgnoreCase)) {
        Fail 'node_path_changed'
    }
    if ($node.Sha256 -ne $ExpectedSha256) { Fail 'node_hash_changed' }
    return $node.Path
}

function Start-PlainChild {
    param(
        [Parameter(Mandatory = $true)][string]$FileName,
        [Parameter(Mandatory = $true)][string]$Arguments,
        [Parameter(Mandatory = $true)][string]$WorkingDirectory
    )
    $startInfo = New-Object System.Diagnostics.ProcessStartInfo
    $startInfo.FileName = $FileName
    $startInfo.Arguments = $Arguments
    $startInfo.WorkingDirectory = $WorkingDirectory
    $startInfo.UseShellExecute = $false
    # Same console-detachment reasoning as the approved Gate 3 child below:
    # a bundle build should not die silently just because the terminal that
    # started `initialize` was closed or reused mid-build.
    $startInfo.CreateNoWindow = $true
    $startInfo.EnvironmentVariables.Clear()
    Add-AllowedParentEnvironment -StartInfo $startInfo
    $process = New-Object System.Diagnostics.Process
    $process.StartInfo = $startInfo
    try {
        if (-not $process.Start()) { Fail 'child_start' }
        $process.WaitForExit()
        if ($process.ExitCode -ne 0) { Fail ('bundle_build_exit_' + $process.ExitCode) }
    } finally {
        $process.Dispose()
    }
}

function Install-ApprovedBundle {
    param(
        [Parameter(Mandatory = $true)][string]$NodePath,
        [Parameter(Mandatory = $true)][string]$SourceRelativePath,
        [Parameter(Mandatory = $true)][string]$Destination,
        [Parameter(Mandatory = $true)][string]$ExpectedSha256
    )
    if ([System.IO.File]::Exists($Destination)) {
        Assert-NoReparseChain -Path $Destination -MustExist $true
        Assert-PrivateAcl -Path $Destination -Directory $false
        if ((Get-Sha256 -Path $Destination) -ne $ExpectedSha256) { Fail 'bundle_hash' }
        return
    }
    $esbuild = [System.IO.Path]::Combine($ApprovedWorktree, 'node_modules', 'esbuild', 'bin', 'esbuild')
    $source = [System.IO.Path]::Combine($ApprovedWorktree, $SourceRelativePath.Replace('/', '\'))
    Assert-NoReparseChain -Path $esbuild -MustExist $true
    Assert-NoReparseChain -Path $source -MustExist $true
    $temporary = [System.IO.Path]::Combine($StoreDirectory, ([Guid]::NewGuid().ToString('N') + '.mjs'))
    try {
        $arguments = '"' + $esbuild + '" "' + $SourceRelativePath + '" --bundle --platform=node --format=esm --packages=bundle --outfile="' + $temporary + '"'
        Start-PlainChild -FileName $NodePath -Arguments $arguments -WorkingDirectory $ApprovedWorktree
        Assert-NoReparseChain -Path $temporary -MustExist $true
        if ((Get-Sha256 -Path $temporary) -ne $ExpectedSha256) { Fail 'bundle_hash' }
        Set-PrivateAcl -Path $temporary -Directory $false
        Assert-PrivateAcl -Path $temporary -Directory $false
        [System.IO.File]::Move($temporary, $Destination)
    } finally {
        if ([System.IO.File]::Exists($temporary)) { [System.IO.File]::Delete($temporary) }
    }
}

function Assert-ApprovedBundle {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$ExpectedSha256
    )
    Assert-NoReparseChain -Path $Path -MustExist $true
    Assert-PrivateAcl -Path $Path -Directory $false
    if ((Get-Sha256 -Path $Path) -ne $ExpectedSha256) { Fail 'bundle_hash' }
}

function ConvertTo-Base64Url {
    param([Parameter(Mandatory = $true)][byte[]]$Bytes)
    return [Convert]::ToBase64String($Bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_')
}

function Initialize-Bootstrap {
    Ensure-StoreDirectory
    Assert-ApprovedWorktree
    Assert-NoReparseChain -Path $ActiveStore -MustExist $false
    Assert-NoReparseChain -Path $InFlightStore -MustExist $false
    if ([System.IO.File]::Exists($ActiveStore)) { Fail 'credential_exists' }
    if ([System.IO.File]::Exists($InFlightStore)) { Fail 'credential_inflight' }

    $node = Resolve-ApprovedNode
    Install-ApprovedBundle -NodePath $node.Path -SourceRelativePath 'server/scripts/antigravity-provisioning-bundle-entry.ts' -Destination $PrepareBundle -ExpectedSha256 $PrepareBundleSha256
    Install-ApprovedBundle -NodePath $node.Path -SourceRelativePath 'server/scripts/antigravity-runtime-bundle-entry.ts' -Destination $RunBundle -ExpectedSha256 $RunBundleSha256

    [byte[]]$randomBytes = New-Object byte[] 32
    [byte[]]$plainBytes = $null
    [byte[]]$cipherBytes = $null
    $bootstrap = $null
    $temporary = [System.IO.Path]::Combine($StoreDirectory, ([Guid]::NewGuid().ToString('N') + '.tmp'))
    try {
        $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
        try {
            $rng.GetBytes($randomBytes)
        } finally {
            $rng.Dispose()
        }
        $bootstrap = 'cb_' + (ConvertTo-Base64Url -Bytes $randomBytes)
        if ($bootstrap -notmatch $BootstrapPattern) { Fail 'bootstrap_format' }
        $plainBytes = [System.Text.Encoding]::UTF8.GetBytes($bootstrap)
        $cipherBytes = [System.Security.Cryptography.ProtectedData]::Protect(
            $plainBytes,
            $Entropy,
            [System.Security.Cryptography.DataProtectionScope]::CurrentUser
        )
        $envelope = [ordered]@{
            version = $StoreVersion
            protection = 'dpapi-current-user'
            createdAt = [DateTime]::UtcNow.ToString('o')
            nodePath = $node.Path
            nodeSha256 = $node.Sha256
            prepareBundleSha256 = $PrepareBundleSha256
            runBundleSha256 = $RunBundleSha256
            ciphertext = [Convert]::ToBase64String($cipherBytes)
        }
        $json = ConvertTo-Json -InputObject $envelope -Compress
        [System.IO.File]::WriteAllText($temporary, $json, (New-Object System.Text.UTF8Encoding($false)))
        Set-PrivateAcl -Path $temporary -Directory $false
        Assert-PrivateAcl -Path $temporary -Directory $false
        [System.IO.File]::Move($temporary, $ActiveStore)
        Assert-PrivateAcl -Path $ActiveStore -Directory $false
        Write-Output 'ANTIGRAVITY_GATE3_INITIALIZED'
    } finally {
        if ([System.IO.File]::Exists($temporary)) {
            [System.IO.File]::Delete($temporary)
        }
        if ($null -ne $randomBytes) { [Array]::Clear($randomBytes, 0, $randomBytes.Length) }
        if ($null -ne $plainBytes) { [Array]::Clear($plainBytes, 0, $plainBytes.Length) }
        if ($null -ne $cipherBytes) { [Array]::Clear($cipherBytes, 0, $cipherBytes.Length) }
        $bootstrap = $null
        $json = $null
        $envelope = $null
    }
}

function Read-Bootstrap {
    param([Parameter(Mandatory = $true)][string]$Path)
    Assert-NoReparseChain -Path $Path -MustExist $true
    Assert-PrivateAcl -Path $Path -Directory $false
    [byte[]]$cipherBytes = $null
    [byte[]]$plainBytes = $null
    try {
        $raw = [System.IO.File]::ReadAllText($Path, [System.Text.Encoding]::UTF8)
        $envelope = ConvertFrom-Json -InputObject $raw
        if ($null -eq $envelope -or $envelope.version -ne $StoreVersion) { Fail 'envelope_version' }
        if ($envelope.protection -ne 'dpapi-current-user') { Fail 'envelope_protection' }
        if ($envelope.prepareBundleSha256 -ne $PrepareBundleSha256) { Fail 'envelope_prepare_bundle' }
        if ($envelope.runBundleSha256 -ne $RunBundleSha256) { Fail 'envelope_run_bundle' }
        $script:ApprovedNodePath = Assert-ApprovedNode -ExpectedPath ([string]$envelope.nodePath) -ExpectedSha256 ([string]$envelope.nodeSha256)
        if ([string]::IsNullOrWhiteSpace([string]$envelope.ciphertext)) { Fail 'envelope_ciphertext' }
        try {
            $cipherBytes = [Convert]::FromBase64String([string]$envelope.ciphertext)
        } catch {
            Fail 'envelope_ciphertext'
        }
        $plainBytes = [System.Security.Cryptography.ProtectedData]::Unprotect(
            $cipherBytes,
            $Entropy,
            [System.Security.Cryptography.DataProtectionScope]::CurrentUser
        )
        $bootstrap = [System.Text.Encoding]::UTF8.GetString($plainBytes)
        if ($bootstrap -notmatch $BootstrapPattern) { Fail 'bootstrap_format' }
        return $bootstrap
    } finally {
        if ($null -ne $cipherBytes) { [Array]::Clear($cipherBytes, 0, $cipherBytes.Length) }
        if ($null -ne $plainBytes) { [Array]::Clear($plainBytes, 0, $plainBytes.Length) }
        $raw = $null
        $envelope = $null
    }
}

function Add-AllowedParentEnvironment {
    param([Parameter(Mandatory = $true)][System.Diagnostics.ProcessStartInfo]$StartInfo)
    $allowed = @(
        'SystemRoot', 'WINDIR', 'ComSpec', 'PATH', 'PATHEXT',
        'TEMP', 'TMP', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA',
        'ProgramFiles', 'ProgramFiles(x86)', 'ProgramW6432'
    )
    foreach ($name in $allowed) {
        $value = [Environment]::GetEnvironmentVariable($name, 'Process')
        if (-not [string]::IsNullOrWhiteSpace($value)) {
            $StartInfo.EnvironmentVariables[$name] = $value
        }
    }
}

function New-ApprovedChild {
    param(
        [Parameter(Mandatory = $true)][string]$Arguments,
        [Parameter(Mandatory = $true)][string]$Bootstrap
    )
    $startInfo = New-Object System.Diagnostics.ProcessStartInfo
    if ([string]::IsNullOrWhiteSpace($script:ApprovedNodePath)) { Fail 'node_not_approved' }
    $startInfo.FileName = $script:ApprovedNodePath
    $startInfo.Arguments = $Arguments
    $startInfo.WorkingDirectory = $ApprovedWorktree
    $startInfo.UseShellExecute = $false
    # The child must not inherit the launcher's console. Windows delivers
    # CTRL_CLOSE_EVENT (and Ctrl+C/Ctrl+Break) to every process attached to a
    # console when that console's window is closed or reused; a console child
    # with no custom handler terminates by default on receiving it. Setting
    # CreateNoWindow gives this child its own hidden console instead of
    # sharing the launcher's, so closing or reusing the terminal that started
    # this script can no longer silently kill an in-progress Gate 3 run.
    # Deliberately not paired with output redirection: piping the child's
    # stdout/stderr back through the launcher's own managed pipes would
    # recreate the same coupling this removes (a killed parent closes its
    # pipe handles out from under the child). The launcher already reports
    # only fixed, non-secret event names, not raw child output.
    $startInfo.CreateNoWindow = $true
    $startInfo.EnvironmentVariables.Clear()
    Add-AllowedParentEnvironment -StartInfo $startInfo
    $startInfo.EnvironmentVariables['COORDINATION_RUNTIME_BOOTSTRAP_TOKEN'] = $Bootstrap
    return $startInfo
}

function Add-RequiredRunEnvironment {
    param([Parameter(Mandatory = $true)][System.Diagnostics.ProcessStartInfo]$StartInfo)
    $required = @(
        'COORDINATION_API_BASE_URL',
        'COORDINATION_RUNTIME_ID',
        'COORDINATION_WINDOW_ID',
        'COORDINATION_OWNERSHIP_RECEIPT_ID',
        'COORDINATION_OWNERSHIP_ARTIFACT_SHA256'
    )
    foreach ($name in $required) {
        $value = [Environment]::GetEnvironmentVariable($name, 'Process')
        if ([string]::IsNullOrWhiteSpace($value)) { Fail ('missing_' + $name.ToLowerInvariant()) }
        $StartInfo.EnvironmentVariables[$name] = $value
    }
    $StartInfo.EnvironmentVariables['COORDINATION_WORKTREE'] = $ApprovedWorktree
    foreach ($name in @('COORDINATION_ASSIGNMENT_EVENT_ID', 'COORDINATION_RECEIPT_FILE')) {
        $value = [Environment]::GetEnvironmentVariable($name, 'Process')
        if (-not [string]::IsNullOrWhiteSpace($value)) {
            $StartInfo.EnvironmentVariables[$name] = $value
        }
    }
}

function Start-ApprovedChild {
    param([Parameter(Mandatory = $true)][System.Diagnostics.ProcessStartInfo]$StartInfo)
    $process = New-Object System.Diagnostics.Process
    $process.StartInfo = $StartInfo
    try {
        if (-not $process.Start()) { Fail 'child_start' }
        $process.WaitForExit()
        return $process.ExitCode
    } finally {
        $StartInfo.EnvironmentVariables.Remove('COORDINATION_RUNTIME_BOOTSTRAP_TOKEN')
        $process.Dispose()
    }
}

function Prepare-PublicBundle {
    if ([string]::IsNullOrWhiteSpace($StartingCommit) -or $StartingCommit -notmatch '^[0-9a-fA-F]{40}$') {
        Fail 'starting_commit'
    }
    Ensure-StoreDirectory
    Assert-ApprovedWorktree
    if ([System.IO.File]::Exists($InFlightStore)) { Fail 'credential_inflight' }
    Assert-ApprovedBundle -Path $PrepareBundle -ExpectedSha256 $PrepareBundleSha256
    $bootstrap = $null
    $startInfo = $null
    try {
        $bootstrap = Read-Bootstrap -Path $ActiveStore
        $arguments = '"' + $PrepareBundle + '" --starting-commit ' + $StartingCommit.ToLowerInvariant()
        $startInfo = New-ApprovedChild -Arguments $arguments -Bootstrap $bootstrap
        $exitCode = Start-ApprovedChild -StartInfo $startInfo
        if ($exitCode -ne 0) { Fail ('child_exit_' + $exitCode) }
    } finally {
        if ($null -ne $startInfo) {
            $startInfo.EnvironmentVariables.Remove('COORDINATION_RUNTIME_BOOTSTRAP_TOKEN')
        }
        $bootstrap = $null
    }
}

function Run-BoundedDriver {
    if (-not [string]::IsNullOrWhiteSpace($StartingCommit)) { Fail 'unexpected_starting_commit' }
    Ensure-StoreDirectory
    Assert-ApprovedWorktree
    Assert-NoReparseChain -Path $ActiveStore -MustExist $true
    if ([System.IO.File]::Exists($InFlightStore)) { Fail 'credential_inflight' }
    Assert-ApprovedBundle -Path $RunBundle -ExpectedSha256 $RunBundleSha256
    try {
        [System.IO.File]::Move($ActiveStore, $InFlightStore)
    } catch {
        Fail 'credential_claim'
    }

    $bootstrap = $null
    $startInfo = $null
    try {
        $bootstrap = Read-Bootstrap -Path $InFlightStore
        $startInfo = New-ApprovedChild -Arguments ('"' + $RunBundle + '"') -Bootstrap $bootstrap
        Add-RequiredRunEnvironment -StartInfo $startInfo
        $exitCode = Start-ApprovedChild -StartInfo $startInfo
        if ($exitCode -ne 0) { Fail ('child_exit_' + $exitCode) }
    } finally {
        if ($null -ne $startInfo) {
            $startInfo.EnvironmentVariables.Remove('COORDINATION_RUNTIME_BOOTSTRAP_TOKEN')
        }
        $bootstrap = $null
        if ([System.IO.File]::Exists($InFlightStore)) {
            [System.IO.File]::Delete($InFlightStore)
        }
    }
}

function Show-Status {
    Ensure-StoreDirectory
    if ([System.IO.File]::Exists($InFlightStore)) {
        Assert-NoReparseChain -Path $InFlightStore -MustExist $true
        Assert-PrivateAcl -Path $InFlightStore -Directory $false
        Write-Output 'ANTIGRAVITY_GATE3_RECOVERY_REQUIRED'
        return
    }
    if ([System.IO.File]::Exists($ActiveStore)) {
        Assert-NoReparseChain -Path $ActiveStore -MustExist $true
        Assert-PrivateAcl -Path $ActiveStore -Directory $false
        Write-Output 'ANTIGRAVITY_GATE3_READY'
        return
    }
    Write-Output 'ANTIGRAVITY_GATE3_UNINITIALIZED'
}

Assert-WindowsRuntime
Assert-NoFixedActorTokens
switch ($Action) {
    'initialize' { Initialize-Bootstrap }
    'prepare' { Prepare-PublicBundle }
    'run' { Run-BoundedDriver }
    'status' { Show-Status }
    default { Fail 'action' }
}