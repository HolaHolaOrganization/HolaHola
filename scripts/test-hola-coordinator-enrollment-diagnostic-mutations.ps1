# Synthetic-only mutation proof. This is not Windows policy, DPAPI, enrollment,
# publication, or native Windows verification. Only private temporary copies run.
[CmdletBinding()]
param(
    [ValidateRange(1, 300)][int]$ChildTimeoutSeconds = 60,
    [switch]$VerifyChildTimeout
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0

function Write-MutationResult {
    param([string]$Id, [ValidateSet('PASS', 'FAIL', 'SKIP')][string]$Status, [string[]]$Checks)
    $record = [ordered]@{ case = $Id; status = $Status; checks = @($Checks) }
    Write-Host ('[coordinator-v2] diagnostic-result ' + (ConvertTo-Json -InputObject $record -Depth 4 -Compress))
}
$phase = if ($VerifyChildTimeout) { 'timeout' } else { 'mutation' }

function Invoke-DiagnosticChild {
    param([string]$Engine, [string]$Command, [string]$Name, [int]$TimeoutSeconds)
    $start = New-Object System.Diagnostics.ProcessStartInfo
    $start.FileName = $Engine
    $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($Command))
    $start.Arguments = '-NoLogo -NoProfile -NonInteractive -EncodedCommand ' + $encoded
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $start.RedirectStandardOutput = $true
    $start.RedirectStandardError = $true
    $child = New-Object System.Diagnostics.Process
    $child.StartInfo = $start
    try {
        if (-not $child.Start()) { throw ('Diagnostic child could not start: ' + $Name) }
        # Drain both streams concurrently: waiting first can deadlock a verbose child.
        $stdout = $child.StandardOutput.ReadToEndAsync()
        $stderr = $child.StandardError.ReadToEndAsync()
        if (-not $child.WaitForExit($TimeoutSeconds * 1000)) {
            # This exact Process instance belongs to this invocation. Never kill
            # unrelated PowerShell processes, or use a global process-name match.
            $child.Kill()
            if (-not $child.WaitForExit(5000)) {
                throw ('Diagnostic child termination failed: ' + $Name)
            }
            $timeout = New-Object System.TimeoutException ('Diagnostic child timed out: ' + $Name)
            $timeout.Data['OwnedChildStopped'] = $child.HasExited
            throw $timeout
        }
        # A descendant must not keep redirected pipes open beyond our deadline.
        if (-not [Threading.Tasks.Task]::WaitAll(
            [Threading.Tasks.Task[]]@($stdout, $stderr), 5000)) {
            throw ('Diagnostic child stream drain timed out: ' + $Name)
        }
        return [pscustomobject]@{
            ExitCode = $child.ExitCode
            Output = $stdout.Result + $stderr.Result
        }
    } finally {
        $child.Dispose()
    }
}

function Replace-DiagnosticMutationOnce {
    param([string]$Text, [string]$Needle, [string]$Replacement)
    $first = $Text.IndexOf($Needle, [StringComparison]::Ordinal)
    if ($first -lt 0 -or $Text.IndexOf($Needle, $first + $Needle.Length, [StringComparison]::Ordinal) -ge 0) {
        throw 'Diagnostic mutation anchor missing or ambiguous'
    }
    return $Text.Substring(0, $first) + $Replacement + $Text.Substring($first + $Needle.Length)
}

$sourcePath = Join-Path $PSScriptRoot 'hola-coordinator.ps1'
$fixturePath = Join-Path $PSScriptRoot 'test-hola-coordinator-recovery-diagnostics.ps1'
$source = [IO.File]::ReadAllText($sourcePath)
$fixture = [IO.File]::ReadAllText($fixturePath)
$wrapper = 'return (Get-InternalHolaCoordinatorHttpFailureDetail -ErrorRecord $ErrorRecord -Context Enrollment)'
$guidanceStart = $source.IndexOf('function Get-HolaCoordinatorEnrollmentGuidance', [StringComparison]::Ordinal)
$guidanceEnd = $source.IndexOf('function Resolve-ApprovedNode', $guidanceStart, [StringComparison]::Ordinal)
if ($guidanceStart -lt 0 -or $guidanceEnd -le $guidanceStart) { throw 'Enrollment guidance boundary missing' }
$guidance = $source.Substring($guidanceStart, $guidanceEnd - $guidanceStart)
$caseInsensitiveGuidance = Replace-DiagnosticMutationOnce -Text $guidance `
    -Needle '[StringComparer]::Ordinal)' -Replacement '[StringComparer]::OrdinalIgnoreCase)'
# Use the exact source spelling; a changed guard must invalidate the proof.
$arrayGuard = '$body.TrimStart().StartsWith(''{'', [StringComparison]::Ordinal)'
$parsedLine = '$parsed = ConvertFrom-Json -InputObject $body -ErrorAction Stop'
# Removing only the delimiter guard does not admit an array on an engine that
# preserves its array type. Model the actual unsafe behavior in the private
# mutant: permit the array and unwrap its sole object before the type check.
$rootArraySource = Replace-DiagnosticMutationOnce -Text $source -Needle $arrayGuard `
    -Replacement ('(' + $arrayGuard + ' -or ($Context -ceq ''Enrollment'' -and $body.TrimStart().StartsWith(''['', [StringComparison]::Ordinal)))')
$rootArraySource = Replace-DiagnosticMutationOnce -Text $rootArraySource -Needle $parsedLine `
    -Replacement ($parsedLine + "`n                " +
        'if ($parsed -is [Array] -and $parsed.Count -eq 1) { $parsed = $parsed[0] }')
$mutations = @(
    @{
        name = 'raw-response'
        source = (Replace-DiagnosticMutationOnce -Text $source -Needle $wrapper `
            -Replacement ('return (' + $wrapper.Substring(7) + ' + [string]$ErrorRecord.ErrorDetails.Message)'))
        failure = 'Enrollment secret reflected'
    },
    @{
        name = 'raw-exception'
        source = (Replace-DiagnosticMutationOnce -Text $source -Needle $wrapper `
            -Replacement ('return (' + $wrapper.Substring(7) + ' + [string]$ErrorRecord.Exception.Message)'))
        failure = 'Enrollment secret reflected'
    },
    @{
        name = 'case-insensitive-guidance'
        source = $source.Substring(0, $guidanceStart) + $caseInsensitiveGuidance + $source.Substring($guidanceEnd)
        failure = 'Enrollment guidance accepted case-insensitive reason'
    },
    @{
        name = 'root-array'
        source = $rootArraySource
        failure = 'Enrollment malformed root array accepted'
    },
    @{ name = 'unmodified'; source = $source; failure = $null }
)
$root = Join-Path ([IO.Path]::GetTempPath()) ('hola-diagnostic-mutations-' + [Guid]::NewGuid().ToString('N'))
$engine = (Get-Process -Id $PID).Path
try {
    if ($VerifyChildTimeout) {
        [void][IO.Directory]::CreateDirectory($root)
        [IO.File]::WriteAllText((Join-Path $root 'cleanup-canary.txt'), 'synthetic fixture')
        $caughtTimeout = $false
        try {
            $null = Invoke-DiagnosticChild -Engine $engine -Name 'synthetic-sleeping-child' `
                -TimeoutSeconds 1 -Command '[Console]::Error.WriteLine("CHILD_ERROR_CANARY"); [Threading.Thread]::Sleep(30000)'
        } catch {
            if ($_.Exception.Message -cne 'Diagnostic child timed out: synthetic-sleeping-child' -or
                $_.Exception.Data['OwnedChildStopped'] -ne $true) {
                Write-MutationResult 'timeout/owned-child' 'FAIL' @('bounded-deadline', 'owned-child-stopped', 'safe-diagnostic')
                throw 'Synthetic child timeout did not stop its owned child with a safe diagnostic'
            }
            $caughtTimeout = $true
        }
        if (-not $caughtTimeout) {
            Write-MutationResult 'timeout/owned-child' 'FAIL' @('bounded-deadline')
            throw 'Synthetic sleeping child unexpectedly completed'
        }
        Write-MutationResult 'timeout/owned-child' 'PASS' @('bounded-deadline', 'owned-child-stopped', 'safe-diagnostic')
        Write-MutationResult 'timeout/mutation-suite' 'SKIP' @('timeout-only-invocation')
    } else {
    foreach ($mutation in $mutations) {
        $directory = Join-Path $root $mutation.name
        [void][IO.Directory]::CreateDirectory($directory)
        [IO.File]::WriteAllText((Join-Path $directory 'hola-coordinator.ps1'), $mutation.source)
        $copy = Join-Path $directory 'test-hola-coordinator-recovery-diagnostics.ps1'
        [IO.File]::WriteAllText($copy, $fixture)
        # Explicit standard modules keep children independent of ambient module
        # discovery (which can scan the whole Nix store in Linux workspaces).
        # These are built-in modules on Windows PowerShell 5.1 as well.
        $bootstrap = '$PSModuleAutoLoadingPreference = ''None''; ' +
            'foreach ($module in @(''Utility'', ''Management'')) { ' +
            'Import-Module ([IO.Path]::Combine($PSHOME, ''Modules'', ''Microsoft.PowerShell.'' + $module, ''Microsoft.PowerShell.'' + $module + ''.psd1'')) }; '
        # Exercise preserved singleton arrays on every engine, in addition to
        # its real parser. This shim applies only inside synthetic child tests.
        $preservedArrayParser = 'function ConvertFrom-Json { [CmdletBinding()] param([string]$InputObject); ' +
            '$decoded = Microsoft.PowerShell.Utility\ConvertFrom-Json -InputObject $InputObject -ErrorAction Stop; ' +
            'if ($InputObject.TrimStart().StartsWith(''['', [StringComparison]::Ordinal)) { ' +
            'Write-Output -NoEnumerate @($decoded) } else { $decoded } }; '
        $modes = @('native-parser')
        if ($mutation.name -ceq 'root-array' -or $mutation.name -ceq 'unmodified') {
            $modes += 'preserved-array-parser'
        }
        # No policy override, profile, credential, runtime, or network operation.
        # The owned process captures stderr directly, so a NativeCommandError
        # cannot preempt inspection of the child's intended assertion failure.
        foreach ($mode in $modes) {
            $id = 'mutation/' + $mutation.name + '/' + $mode
            $command = $bootstrap
            if ($mode -ceq 'preserved-array-parser') { $command += $preservedArrayParser }
            $command += '& ''' + $copy.Replace("'", "''") + ''' -SkipMutationChecks'
            try {
                $result = Invoke-DiagnosticChild -Engine $engine -Command $command `
                    -Name ($mutation.name + '/' + $mode) -TimeoutSeconds $ChildTimeoutSeconds
            } catch {
                Write-MutationResult $id 'FAIL' @('child-completed-within-deadline')
                throw
            }
            $output = $result.Output
            $exitCode = $result.ExitCode
            if ($null -eq $mutation.failure) {
                if ($exitCode -ne 0 -or -not $output.Contains('Synthetic safe enrollment and recovery diagnostic checks passed')) {
                    Write-MutationResult $id 'FAIL' @('control-exit-zero', 'control-baseline-complete')
                    throw ('Unmodified synthetic diagnostic fixture failed: ' + $mode)
                }
                $checks = @('control-exit-zero', 'control-baseline-complete')
            } elseif ($exitCode -eq 0 -or -not $output.Contains($mutation.failure)) {
                Write-MutationResult $id 'FAIL' @('mutation-exit-nonzero', 'intended-assertion-rejected')
                throw ('Diagnostic mutation did not fail its intended assertion: ' + $mutation.name + '/' + $mode)
            } else {
                $checks = @('mutation-exit-nonzero', 'intended-assertion-rejected')
            }
            Write-MutationResult $id 'PASS' $checks
            Write-Host ('[coordinator-v2] Synthetic mutation proof passed: ' + $mutation.name + '/' + $mode)
        }
    }
    }
} finally {
    if ([IO.Directory]::Exists($root)) { [IO.Directory]::Delete($root, $true) }
}
if ($VerifyChildTimeout) {
    if ([IO.Directory]::Exists($root)) {
        Write-MutationResult 'timeout/owned-temp-cleanup' 'FAIL' @('owned-root-removed')
        throw 'Synthetic timeout temporary directory was not removed'
    }
    Write-MutationResult 'timeout/owned-temp-cleanup' 'PASS' @('owned-root-removed')
    Write-Host '[coordinator-v2] Synthetic child timeout, safe diagnostic, and cleanup proof passed'
} else {
    Write-MutationResult 'mutation/owned-temp-cleanup' 'PASS' @('owned-root-removed')
}
if ([IO.File]::ReadAllText($sourcePath) -cne $source -or [IO.File]::ReadAllText($fixturePath) -cne $fixture) {
    Write-MutationResult ($phase + '/source-preservation') 'FAIL' @('original-source-unchanged', 'original-fixture-unchanged')
    throw 'Original diagnostic source or fixture changed during mutation proof'
}
Write-MutationResult ($phase + '/source-preservation') 'PASS' @('original-source-unchanged', 'original-fixture-unchanged')
if (-not $VerifyChildTimeout) {
    Write-MutationResult 'mutation-suite' 'PASS' @('all-requested-mutation-and-control-runs-completed')
}
